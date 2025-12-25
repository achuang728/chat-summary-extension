import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, getRequestHeaders, generateRaw, chat_metadata } from "../../../../script.js";
import { getSortedEntries, saveWorldInfo, loadWorldInfo } from "../../../world-info.js";

// 世界书模块 - 动态获取
let worldInfoModule = null;

const extensionName = "chat-summary-extension";

// 默认设置
const defaultSettings = {
  enabled: true,
  
  // API设置
  useCustomApi: false,
  apiUrl: "",
  apiKey: "",
  apiModel: "",
  
  // 小总结设置
  floorRange: "0-10",
  excludePattern: "<thinking>[\\s\\S]*?</thinking>",
  
  // 世界书设置
  selectedWorldbook: "",
  smallSummaryEntryName: "小总结",
  bigSummaryEntryName: "大总结",
};

// 提示词
const SMALL_SUMMARY_PROMPT = `你是剧情记录助手。请根据以下对话内容，生成简洁的剧情总结。

要求：
1. 客观记录发生的事件、对话、人物行动
2. 保留关键信息（人物、地点、重要对话）
3. 使用第三人称
4. 字数控制在400字以内
5. 直接输出总结内容，不要任何前缀说明

对话内容：
{{chatContent}}`;

const BIG_SUMMARY_PROMPT = `你是剧情归纳助手。请将以下多条剧情小总结合并精简为更简洁的大总结。

要求：
1. 保留最重要的剧情发展
2. 合并相似或连续的事件
3. 保持时间顺序
4. 输出一段连贯的总结

现有小总结：
{{summaries}}

请输出合并后的大总结：`;

let isProcessing = false;

// ============ 设置管理 ============

function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
  for (const key in defaultSettings) {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = defaultSettings[key];
    }
  }
  updateUI();
}

function saveSettings() {
  saveSettingsDebounced();
}

function getSettings() {
  return extension_settings[extensionName];
}

// ============ API调用 ============

/**
 * 通过酒馆后端代理调用自定义OpenAI兼容API
 * 关键：请求从酒馆Node.js后端发出，不是从浏览器发出，所以没有CORS问题
 */
async function callCustomApi(prompt) {
  const settings = getSettings();
  
  if (!settings.apiUrl || !settings.apiKey || !settings.apiModel) {
    throw new Error("请先配置API地址、密钥和模型");
  }
  
  // 构建API端点
  let apiUrl = settings.apiUrl.trim().replace(/\/+$/, "");
  if (!apiUrl.endsWith("/v1")) {
    apiUrl = `${apiUrl}/v1`;
  }
  
  console.log("[聊天总结] 调用自定义API:", apiUrl);
  
  // 通过酒馆后端的代理端点发送请求
  const response = await fetch("/api/backends/chat-completions/generate", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      chat_completion_source: "custom",
      custom_url: apiUrl,
      custom_include_headers: JSON.stringify({
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      }),
      model: settings.apiModel,
      max_tokens: 2000,
      temperature: 0.7,
      messages: [
        { role: "user", content: prompt }
      ],
      stream: false
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error("[聊天总结] API错误:", response.status, errorText);
    throw new Error(`API错误 ${response.status}: ${errorText.substring(0, 200)}`);
  }
  
  const text = await response.text();
  
  try {
    const data = JSON.parse(text);
    if (data.choices && data.choices[0]) {
      return data.choices[0].message?.content || data.choices[0].text || "";
    }
    if (data.content) {
      return data.content;
    }
    return text;
  } catch {
    return text;
  }
}

/**
 * 使用酒馆主API（通过generateRaw）
 * generateRaw从后端发送请求，没有CORS问题
 */
async function callMainApi(prompt) {
  return await generateRaw(prompt);
}

/**
 * 统一的AI调用入口
 */
async function callAI(prompt) {
  const settings = getSettings();
  
  if (settings.useCustomApi && settings.apiUrl && settings.apiKey && settings.apiModel) {
    console.log("[聊天总结] 使用独立API");
    return await callCustomApi(prompt);
  }
  
  console.log("[聊天总结] 使用酒馆主API");
  return await callMainApi(prompt);
}

/**
 * 测试API连接
 */
async function testCustomApi() {
  const settings = getSettings();
  
  if (!settings.apiUrl || !settings.apiKey || !settings.apiModel) {
    toastr.warning("请先填写API地址、密钥和模型", "聊天总结");
    return;
  }
  
  toastr.info("正在测试API连接...", "聊天总结");
  
  try {
    const result = await callCustomApi("请回复'测试成功'这四个字");
    toastr.success(`API测试成功！回复: ${result.substring(0, 50)}...`, "聊天总结", { timeOut: 5000 });
  } catch (error) {
    toastr.error(`API测试失败: ${error.message}`, "聊天总结", { timeOut: 10000 });
    console.error("[聊天总结] API测试失败:", error);
  }
}

// ============ 世界书操作 ============

async function getWorldbooks() {
  const worldbookList = [];
  const context = getContext();
  
  // 调试：打印chat_metadata完整结构
  console.log("[聊天总结] 导入的chat_metadata:", chat_metadata);
  console.log("[聊天总结] context.chat_metadata:", context.chat_metadata);
  
  // 1. 角色绑定的世界书
  if (context.characters && context.characterId !== undefined) {
    const char = context.characters[context.characterId];
    
    if (char?.data?.extensions?.world) {
      const mainWorld = char.data.extensions.world;
      if (mainWorld && typeof mainWorld === 'string') {
        worldbookList.push({
          name: mainWorld,
          displayName: mainWorld + " (角色绑定)"
        });
        console.log("[聊天总结] 角色绑定世界书:", mainWorld);
      }
    }
  }
  
  // 2. 聊天绑定的世界书 - 使用导入的chat_metadata
  // chat_metadata.world_info 存储聊天绑定的世界书名称
  if (chat_metadata && chat_metadata.world_info) {
    const chatWorld = chat_metadata.world_info;
    if (chatWorld && typeof chatWorld === 'string') {
      if (!worldbookList.find(w => w.name === chatWorld)) {
        worldbookList.push({
          name: chatWorld,
          displayName: chatWorld + " (聊天绑定)"
        });
        console.log("[聊天总结] 聊天绑定世界书:", chatWorld);
      }
    }
  }
  
  if (worldbookList.length === 0) {
    console.log("[聊天总结] 未找到任何世界书");
  }
  
  console.log("[聊天总结] 最终世界书列表:", worldbookList);
  return worldbookList;
}

async function updateWorldbookSelect() {
  const settings = getSettings();
  const $select = $("#chat_summary_worldbook");
  
  $select.empty().append(`<option value="">-- 选择世界书 --</option>`);
  
  const worldbooks = await getWorldbooks();
  
  worldbooks.forEach(wb => {
    $select.append(`<option value="${wb.name}">${wb.displayName}</option>`);
  });
  
  if (settings.selectedWorldbook) {
    $select.val(settings.selectedWorldbook);
  }
  
  toastr.success(`找到 ${worldbooks.length} 个世界书`, "聊天总结");
}

async function saveToWorldbook(entryName, content) {
  const settings = getSettings();
  const worldbookName = settings.selectedWorldbook;
  
  if (!worldbookName) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return false;
  }
  
  console.log("[聊天总结] 保存到世界书:", worldbookName, "条目:", entryName);
  
  try {
    // 使用酒馆的loadWorldInfo加载世界书
    let worldData = await loadWorldInfo(worldbookName);
    
    if (!worldData) {
      console.error("[聊天总结] 无法加载世界书:", worldbookName);
      toastr.error("无法加载世界书: " + worldbookName, "聊天总结");
      return false;
    }
    
    // 确保entries存在
    if (!worldData.entries) {
      worldData.entries = {};
    }
    
    // 查找现有条目
    let found = false;
    
    for (const uid in worldData.entries) {
      const entry = worldData.entries[uid];
      if (entry.comment === entryName || (entry.key && entry.key.includes(entryName))) {
        // 更新现有条目
        worldData.entries[uid].content = content;
        found = true;
        console.log("[聊天总结] 更新现有条目 UID:", uid);
        break;
      }
    }
    
    if (!found) {
      // 创建新条目
      const newUid = Date.now();
      worldData.entries[newUid] = {
        uid: newUid,
        key: [entryName],
        keysecondary: [],
        comment: entryName,
        content: content,
        constant: true,
        vectorized: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: "",
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: "",
        role: null,
        sticky: null,
        cooldown: null,
        delay: null
      };
      console.log("[聊天总结] 创建新条目 UID:", newUid);
    }
    
    // 使用酒馆的saveWorldInfo保存，第三个参数true表示立即保存
    await saveWorldInfo(worldbookName, worldData, true);
    console.log("[聊天总结] 世界书保存成功");
    return true;
    
  } catch (error) {
    console.error("[聊天总结] 保存世界书失败:", error);
    toastr.error("保存世界书失败: " + error.message, "聊天总结");
    return false;
  }
}

async function readFromWorldbook(entryName) {
  const settings = getSettings();
  const worldbookName = settings.selectedWorldbook;
  
  if (!worldbookName) return null;
  
  try {
    // 使用酒馆的loadWorldInfo加载世界书
    const worldData = await loadWorldInfo(worldbookName);
    
    if (!worldData || !worldData.entries) {
      console.log("[聊天总结] 世界书不存在或为空:", worldbookName);
      return null;
    }
    
    // 查找条目
    for (const uid in worldData.entries) {
      const entry = worldData.entries[uid];
      if (entry.comment === entryName || (entry.key && entry.key.includes(entryName))) {
        return entry.content;
      }
    }
    
    return null;
  } catch (error) {
    console.error("[聊天总结] 读取世界书失败:", error);
    return null;
  }
}

// ============ 聊天内容处理 ============

function getSelectedContent() {
  const settings = getSettings();
  const context = getContext();
  
  if (!context.chat || context.chat.length === 0) {
    return { content: "", messages: [], floorRange: "0-0" };
  }
  
  const rangeStr = settings.floorRange || "0-10";
  let [start, end] = rangeStr.split("-").map(s => parseInt(s.trim()));
  
  if (isNaN(start)) start = 0;
  if (isNaN(end)) end = context.chat.length - 1;
  
  start = Math.max(0, start);
  end = Math.min(context.chat.length - 1, end);
  
  if (start > end) {
    [start, end] = [end, start];
  }
  
  const messages = [];
  const excludeRegex = settings.excludePattern ? new RegExp(settings.excludePattern, "gi") : null;
  
  for (let i = start; i <= end; i++) {
    const msg = context.chat[i];
    if (!msg || msg.is_system) continue;
    
    let text = msg.mes || "";
    
    if (excludeRegex) {
      text = text.replace(excludeRegex, "");
    }
    
    text = text.trim();
    if (!text) continue;
    
    const role = msg.is_user ? "用户" : (msg.name || "角色");
    messages.push({
      index: i,
      role,
      text
    });
  }
  
  const content = messages.map(m => `[${m.role}]: ${m.text}`).join("\n\n");
  const floorRange = `${start}-${end}`;
  
  return { content, messages, floorRange };
}

// ============ 弹窗 ============

function showPreviewPopup(content, onConfirm) {
  const html = `
    <div style="max-height:400px;overflow-y:auto;padding:10px;background:#1a1a1a;border-radius:5px;margin-bottom:15px;">
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;color:#ddd;">${escapeHtml(content)}</pre>
    </div>
    <div style="text-align:right;">
      <button id="popup_cancel" class="menu_button">取消</button>
      <button id="popup_confirm" class="menu_button" style="margin-left:10px;">确认生成</button>
    </div>
  `;
  
  const popup = document.createElement("div");
  popup.innerHTML = `
    <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;">
      <div style="background:#2a2a2a;padding:20px;border-radius:10px;max-width:600px;width:90%;">
        <h3 style="margin-top:0;color:#fff;">预览内容</h3>
        ${html}
      </div>
    </div>
  `;
  
  document.body.appendChild(popup);
  
  popup.querySelector("#popup_cancel").onclick = () => popup.remove();
  popup.querySelector("#popup_confirm").onclick = () => {
    popup.remove();
    onConfirm();
  };
}

function showResultPopup(title, content) {
  const html = `
    <div style="max-height:400px;overflow-y:auto;padding:10px;background:#1a1a1a;border-radius:5px;margin-bottom:15px;">
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;color:#ddd;">${escapeHtml(content)}</pre>
    </div>
    <div style="text-align:right;">
      <button id="popup_close" class="menu_button">关闭</button>
    </div>
  `;
  
  const popup = document.createElement("div");
  popup.innerHTML = `
    <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;">
      <div style="background:#2a2a2a;padding:20px;border-radius:10px;max-width:600px;width:90%;">
        <h3 style="margin-top:0;color:#fff;">${title}</h3>
        ${html}
      </div>
    </div>
  `;
  
  document.body.appendChild(popup);
  popup.querySelector("#popup_close").onclick = () => popup.remove();
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============ 核心功能 ============

function previewSmallSummary() {
  const settings = getSettings();
  const { content, messages, floorRange } = getSelectedContent();
  
  if (!content || messages.length === 0) {
    toastr.warning("选中的楼层范围没有内容", "聊天总结");
    return;
  }
  
  showPreviewPopup(content, () => generateSmallSummary(content, floorRange));
}

async function generateSmallSummary(content, floorRange) {
  if (isProcessing) return;
  
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return;
  }
  
  isProcessing = true;
  toastr.info("正在生成小总结...", "聊天总结");
  
  try {
    const prompt = SMALL_SUMMARY_PROMPT.replace("{{chatContent}}", content);
    const summary = await callAI(prompt);
    
    if (summary && summary.trim()) {
      let existing = await readFromWorldbook(settings.smallSummaryEntryName) || "";
      const floorLabel = `楼层 ${floorRange}`;
      const newContent = existing 
        ? `${existing}\n\n---\n\n【${floorLabel}】\n${summary.trim()}`
        : `【${floorLabel}】\n${summary.trim()}`;
      
      const saved = await saveToWorldbook(settings.smallSummaryEntryName, newContent);
      
      if (saved) {
        toastr.success("小总结已保存到世界书", "聊天总结");
      }
      
      showResultPopup("小总结生成完成", summary.trim());
    }
  } catch (e) {
    toastr.error("生成失败: " + e.message, "聊天总结");
    console.error("[聊天总结]", e);
  } finally {
    isProcessing = false;
  }
}

async function generateBigSummary() {
  if (isProcessing) return;
  
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return;
  }
  
  const smallSummaries = await readFromWorldbook(settings.smallSummaryEntryName);
  
  if (!smallSummaries) {
    toastr.warning("没有找到小总结，请先生成", "聊天总结");
    return;
  }
  
  showPreviewPopup(smallSummaries, async () => {
    isProcessing = true;
    toastr.info("正在生成大总结...", "聊天总结");
    
    try {
      const prompt = BIG_SUMMARY_PROMPT.replace("{{summaries}}", smallSummaries);
      const result = await callAI(prompt);
      
      if (result && result.trim()) {
        // 追加模式
        let existing = await readFromWorldbook(settings.bigSummaryEntryName) || "";
        const newContent = existing 
          ? `${existing}\n\n---\n\n${result.trim()}`
          : result.trim();
        
        const saved = await saveToWorldbook(settings.bigSummaryEntryName, newContent);
        
        if (saved) {
          toastr.success("大总结已保存到世界书", "聊天总结");
        }
        
        showResultPopup("大总结生成完成", result.trim());
      }
    } catch (e) {
      toastr.error("生成失败: " + e.message, "聊天总结");
    } finally {
      isProcessing = false;
    }
  });
}

// ============ UI ============

function updateUI() {
  const settings = getSettings();
  if (!settings) return;
  
  $("#chat_summary_enabled").prop("checked", settings.enabled);
  $("#chat_summary_use_custom_api").prop("checked", settings.useCustomApi);
  $("#chat_summary_api_url").val(settings.apiUrl);
  $("#chat_summary_api_key").val(settings.apiKey);
  $("#chat_summary_api_model").val(settings.apiModel);
  $("#chat_summary_floor_range").val(settings.floorRange);
  $("#chat_summary_exclude").val(settings.excludePattern);
  $("#chat_summary_small_entry").val(settings.smallSummaryEntryName);
  $("#chat_summary_big_entry").val(settings.bigSummaryEntryName);
  
  if (settings.useCustomApi) {
    $("#chat_summary_api_settings").show();
  } else {
    $("#chat_summary_api_settings").hide();
  }
}

function createUI() {
  const html = `
  <div id="chat_summary_panel">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>📝 聊天总结助手</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        
        <div class="chat-summary-section">
          <label class="checkbox_label">
            <input type="checkbox" id="chat_summary_enabled" checked>
            <span>启用扩展</span>
          </label>
        </div>
        
        <hr>
        
        <div class="chat-summary-section">
          <b>🔌 API设置</b>
          <div style="margin-top:8px;">
            <label class="checkbox_label">
              <input type="checkbox" id="chat_summary_use_custom_api">
              <span>使用独立API</span>
            </label>
            <p style="font-size:11px;opacity:0.6;margin:5px 0 0 0;">关闭则使用酒馆主界面配置的API</p>
          </div>
          <div id="chat_summary_api_settings" style="display:none;margin-top:10px;">
            <div style="margin-bottom:8px;">
              <label>API地址</label>
              <input type="text" id="chat_summary_api_url" class="text_pole" placeholder="http://127.0.0.1:8888">
            </div>
            <div style="margin-bottom:8px;">
              <label>API密钥</label>
              <input type="password" id="chat_summary_api_key" class="text_pole" placeholder="sk-xxx">
            </div>
            <div style="margin-bottom:8px;">
              <label>模型名称</label>
              <input type="text" id="chat_summary_api_model" class="text_pole" placeholder="gpt-3.5-turbo">
            </div>
            <div class="menu_button" id="chat_summary_test_api" style="margin-top:5px;">🧪 测试连接</div>
          </div>
        </div>
        
        <hr>
        
        <div class="chat-summary-section">
          <b>📖 世界书设置</b>
          <div style="margin-top:8px;">
            <label>目标世界书</label>
            <select id="chat_summary_worldbook" class="text_pole">
              <option value="">-- 选择 --</option>
            </select>
            <div class="menu_button" id="chat_summary_refresh_wb" style="margin-top:5px;">🔄 刷新</div>
          </div>
          <div style="margin-top:8px;">
            <label>小总结条目名</label>
            <input type="text" id="chat_summary_small_entry" class="text_pole" value="小总结">
          </div>
          <div style="margin-top:8px;">
            <label>大总结条目名</label>
            <input type="text" id="chat_summary_big_entry" class="text_pole" value="大总结">
          </div>
        </div>
        
        <hr>
        
        <div class="chat-summary-section">
          <b>📌 小总结</b>
          <div style="margin-top:8px;">
            <label>楼层范围</label>
            <input type="text" id="chat_summary_floor_range" class="text_pole" value="0-10" placeholder="0-10">
          </div>
          <div style="margin-top:8px;">
            <label>排除内容(正则)</label>
            <input type="text" id="chat_summary_exclude" class="text_pole" placeholder="<thinking>[\\s\\S]*?</thinking>">
          </div>
          <div class="menu_button" id="chat_summary_gen_small" style="margin-top:10px;width:100%;text-align:center;">✨ 生成小总结</div>
        </div>
        
        <hr>
        
        <div class="chat-summary-section">
          <b>📚 大总结</b>
          <div class="menu_button" id="chat_summary_gen_big" style="margin-top:8px;width:100%;text-align:center;">📚 生成大总结</div>
          <p style="font-size:11px;opacity:0.6;margin-top:5px;">从世界书小总结条目合并生成</p>
        </div>
        
      </div>
    </div>
  </div>`;
  
  $("#extensions_settings").append(html);
}

function bindEvents() {
  const settings = getSettings();
  
  $("#chat_summary_enabled").on("change", function() {
    settings.enabled = $(this).prop("checked");
    saveSettings();
  });
  
  $("#chat_summary_use_custom_api").on("change", function() {
    settings.useCustomApi = $(this).prop("checked");
    saveSettings();
    updateUI();
  });
  
  $("#chat_summary_api_url").on("change", function() {
    settings.apiUrl = $(this).val().trim();
    saveSettings();
  });
  
  $("#chat_summary_api_key").on("change", function() {
    settings.apiKey = $(this).val().trim();
    saveSettings();
  });
  
  $("#chat_summary_api_model").on("change", function() {
    settings.apiModel = $(this).val().trim();
    saveSettings();
  });
  
  $("#chat_summary_test_api").on("click", testCustomApi);
  
  $("#chat_summary_worldbook").on("change", function() {
    settings.selectedWorldbook = $(this).val();
    saveSettings();
  });
  
  $("#chat_summary_refresh_wb").on("click", updateWorldbookSelect);
  
  $("#chat_summary_small_entry").on("change", function() {
    settings.smallSummaryEntryName = $(this).val() || "小总结";
    saveSettings();
  });
  
  $("#chat_summary_big_entry").on("change", function() {
    settings.bigSummaryEntryName = $(this).val() || "大总结";
    saveSettings();
  });
  
  $("#chat_summary_floor_range").on("change", function() {
    settings.floorRange = $(this).val() || "0-10";
    saveSettings();
  });
  
  $("#chat_summary_exclude").on("change", function() {
    settings.excludePattern = $(this).val();
    saveSettings();
  });
  
  $("#chat_summary_gen_small").on("click", previewSmallSummary);
  $("#chat_summary_gen_big").on("click", generateBigSummary);
}

// 初始化
jQuery(async () => {
  console.log("[聊天总结助手] 加载中...");
  createUI();
  loadSettings();
  bindEvents();
  setTimeout(updateWorldbookSelect, 2000);
  console.log("[聊天总结助手] 加载完成");
});
