import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

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

async function callCustomApi(prompt) {
  const settings = getSettings();
  
  if (!settings.apiUrl || !settings.apiKey || !settings.apiModel) {
    throw new Error("请先配置API地址、密钥和模型");
  }
  
  let baseUrl = settings.apiUrl.trim().replace(/\/+$/, "");
  let endpoint = baseUrl.includes("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  
  console.log("[聊天总结] 调用自定义API:", endpoint);
  
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.apiModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API错误 ${response.status}: ${errorText}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callAI(prompt) {
  const settings = getSettings();
  
  if (settings.useCustomApi && settings.apiUrl && settings.apiKey && settings.apiModel) {
    return await callCustomApi(prompt);
  }
  
  // 使用酒馆API
  const context = getContext();
  return await context.generateQuietPrompt(prompt, false, false);
}

// ============ 世界书操作 ============

async function getWorldbooks() {
  const worldbookList = [];
  
  // 从DOM获取
  $("#world_info option, #world_editor_select option").each(function() {
    const val = $(this).val();
    const text = $(this).text().trim();
    if (val && text && val !== "" && text !== "None" && text !== "无" && !text.includes("选择")) {
      if (!worldbookList.find(w => w.name === val)) {
        worldbookList.push({ name: val, displayName: text });
      }
    }
  });
  
  // 从角色获取
  const context = getContext();
  if (context.characters && context.characterId !== undefined) {
    const char = context.characters[context.characterId];
    if (char?.data?.extensions?.world) {
      const charWorld = char.data.extensions.world;
      if (!worldbookList.find(w => w.name === charWorld)) {
        worldbookList.push({ name: charWorld, displayName: `${charWorld} (角色)` });
      }
    }
  }
  
  console.log("[聊天总结] 世界书列表:", worldbookList);
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

// 操作世界书条目
async function saveToWorldbook(entryName, content) {
  const settings = getSettings();
  const worldbookName = settings.selectedWorldbook;
  
  if (!worldbookName) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return false;
  }
  
  console.log("[聊天总结] 保存到世界书:", worldbookName, "条目:", entryName);
  
  try {
    // 方法1: 使用SillyTavern的全局函数
    if (typeof window.saveWorldInfo === 'function') {
      console.log("[聊天总结] 使用全局saveWorldInfo");
      // 先获取数据
      const data = await window.getWorldInfo?.(worldbookName);
      if (data) {
        // 更新或添加条目
        // ...
      }
    }
    
    // 方法2: 直接操作world_info对象
    if (typeof world_info !== 'undefined') {
      console.log("[聊天总结] 找到全局world_info对象");
      const entries = world_info?.data?.entries || world_info?.entries;
      if (entries) {
        let found = false;
        for (const uid in entries) {
          if (entries[uid].comment === entryName || entries[uid].key?.includes(entryName)) {
            entries[uid].content = content;
            found = true;
            break;
          }
        }
        if (!found) {
          const newUid = Date.now();
          entries[newUid] = {
            uid: newUid,
            key: [entryName],
            comment: entryName,
            content: content,
            constant: true,
            disable: false,
            order: 100,
            position: 0
          };
        }
        
        // 触发保存事件
        $(document).trigger('worldInfoUpdated');
        console.log("[聊天总结] 已更新world_info对象");
      }
    }
    
    // 方法3: 使用jQuery事件触发酒馆保存
    const $saveBtn = $('[id*="world_info_save"], .world_info_save');
    if ($saveBtn.length) {
      $saveBtn.trigger('click');
      console.log("[聊天总结] 触发保存按钮");
      return true;
    }
    
    // 方法4: 使用fetch但加上正确的headers
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    
    // 先读取现有数据
    const getResp = await fetch("/getWorldInfo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ name: worldbookName })
    });
    
    if (getResp.ok) {
      const worldData = await getResp.json();
      const entries = worldData.entries || {};
      
      // 查找或创建条目
      let found = false;
      for (const uid in entries) {
        if (entries[uid].comment === entryName || entries[uid].key?.includes(entryName)) {
          entries[uid].content = content;
          found = true;
          break;
        }
      }
      
      if (!found) {
        const newUid = Object.keys(entries).length;
        entries[newUid] = {
          uid: newUid,
          key: [entryName],
          comment: entryName,
          content: content,
          constant: true,
          disable: false
        };
      }
      
      // 保存
      const saveResp = await fetch("/saveWorldInfo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          name: worldbookName,
          data: { entries }
        })
      });
      
      if (saveResp.ok) {
        console.log("[聊天总结] fetch保存成功");
        return true;
      }
    }
    
    console.log("[聊天总结] 所有方法都失败");
    return false;
    
  } catch (e) {
    console.error("[聊天总结] 保存失败:", e);
    return false;
  }
}

// 从世界书读取
async function readFromWorldbook(entryName) {
  const settings = getSettings();
  const worldbookName = settings.selectedWorldbook;
  
  if (!worldbookName) return null;
  
  console.log("[聊天总结] 从世界书读取:", worldbookName, "条目:", entryName);
  
  try {
    // 方法1: 检查全局world_info
    if (typeof world_info !== 'undefined') {
      const entries = world_info?.data?.entries || world_info?.entries;
      if (entries) {
        for (const uid in entries) {
          if (entries[uid].comment === entryName || entries[uid].key?.includes(entryName)) {
            console.log("[聊天总结] 从全局world_info读取成功");
            return entries[uid].content;
          }
        }
      }
    }
    
    // 方法2: 使用fetch
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    
    const resp = await fetch("/getWorldInfo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ name: worldbookName })
    });
    
    if (resp.ok) {
      const data = await resp.json();
      const entries = data.entries || {};
      
      for (const uid in entries) {
        if (entries[uid].comment === entryName || entries[uid].key?.includes(entryName)) {
          console.log("[聊天总结] 从API读取成功");
          return entries[uid].content;
        }
      }
    }
    
    return null;
  } catch (e) {
    console.error("[聊天总结] 读取失败:", e);
    return null;
  }
}

// ============ 楼层选择 ============

function parseFloorRange(rangeStr) {
  const parts = rangeStr.split("-");
  if (parts.length !== 2) return { start: 0, end: 10 };
  return {
    start: parseInt(parts[0].trim()) || 0,
    end: parseInt(parts[1].trim()) || 10
  };
}

function getSelectedContent() {
  const context = getContext();
  const chat = context.chat;
  const settings = getSettings();
  
  if (!chat || chat.length === 0) {
    return { content: "", messages: [] };
  }
  
  const { start, end } = parseFloorRange(settings.floorRange);
  const messages = [];
  
  for (let i = start; i <= end && i < chat.length; i++) {
    const msg = chat[i];
    if (!msg) continue;
    
    let content = msg.mes || "";
    
    if (settings.excludePattern && settings.excludePattern.trim()) {
      try {
        const regex = new RegExp(settings.excludePattern, "gi");
        content = content.replace(regex, "");
      } catch (e) {}
    }
    
    content = content.trim();
    if (content) {
      messages.push({
        floor: i,
        name: msg.name || (msg.is_user ? "用户" : "AI"),
        content: content
      });
    }
  }
  
  const formattedContent = messages.map(m => 
    `【第${m.floor}楼 - ${m.name}】\n${m.content}`
  ).join("\n\n---\n\n");
  
  return { content: formattedContent, messages };
}

// ============ 弹窗 ============

function showPreviewPopup(content, onConfirm) {
  $("#chat_summary_popup_overlay").remove();
  
  $("body").append(`
    <div id="chat_summary_popup_overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;">
      <div style="background:#1e1e2e;border-radius:12px;width:90%;max-width:600px;max-height:80vh;display:flex;flex-direction:column;">
        <div style="padding:16px 20px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:600;">📄 待总结内容预览</span>
          <button id="chat_summary_popup_close" style="background:rgba(255,255,255,0.2);border:none;color:white;width:32px;height:32px;border-radius:50%;cursor:pointer;">×</button>
        </div>
        <div style="padding:16px;overflow-y:auto;flex:1;font-size:14px;line-height:1.6;white-space:pre-wrap;color:#e0e0e0;">${escapeHtml(content)}</div>
        <div style="padding:16px;display:flex;gap:12px;border-top:1px solid rgba(255,255,255,0.1);">
          <button id="chat_summary_popup_cancel" style="flex:1;padding:12px;background:#444;border:none;border-radius:8px;color:white;cursor:pointer;">取消</button>
          <button id="chat_summary_popup_confirm" style="flex:1;padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:8px;color:white;cursor:pointer;font-weight:600;">✨ 开始总结</button>
        </div>
      </div>
    </div>
  `);
  
  $("#chat_summary_popup_close, #chat_summary_popup_cancel").on("click", () => $("#chat_summary_popup_overlay").remove());
  $("#chat_summary_popup_confirm").on("click", () => {
    $("#chat_summary_popup_overlay").remove();
    if (onConfirm) onConfirm();
  });
}

function showResultPopup(title, content) {
  $("#chat_summary_popup_overlay").remove();
  
  $("body").append(`
    <div id="chat_summary_popup_overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;">
      <div style="background:#1e1e2e;border-radius:12px;width:90%;max-width:600px;max-height:80vh;display:flex;flex-direction:column;">
        <div style="padding:16px 20px;background:linear-gradient(135deg,#27ae60,#2ecc71);border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:600;">✅ ${escapeHtml(title)}</span>
          <button id="chat_summary_popup_close" style="background:rgba(255,255,255,0.2);border:none;color:white;width:32px;height:32px;border-radius:50%;cursor:pointer;">×</button>
        </div>
        <div style="padding:16px;overflow-y:auto;flex:1;font-size:14px;line-height:1.6;white-space:pre-wrap;color:#e0e0e0;user-select:text;">${escapeHtml(content)}</div>
        <div style="padding:16px;display:flex;gap:12px;border-top:1px solid rgba(255,255,255,0.1);">
          <button id="chat_summary_copy_btn" style="flex:1;padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:8px;color:white;cursor:pointer;font-weight:600;">📋 复制</button>
          <button id="chat_summary_popup_cancel" style="flex:1;padding:12px;background:#444;border:none;border-radius:8px;color:white;cursor:pointer;">关闭</button>
        </div>
      </div>
    </div>
  `);
  
  $("#chat_summary_popup_close, #chat_summary_popup_cancel").on("click", () => $("#chat_summary_popup_overlay").remove());
  $("#chat_summary_copy_btn").on("click", () => {
    navigator.clipboard.writeText(content).then(() => toastr.success("已复制", "聊天总结"));
  });
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============ 核心功能 ============

function previewSmallSummary() {
  const { content, messages } = getSelectedContent();
  
  if (!content || messages.length === 0) {
    toastr.warning("选中的楼层范围没有内容", "聊天总结");
    return;
  }
  
  showPreviewPopup(content, () => generateSmallSummary(content));
}

async function generateSmallSummary(content) {
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
      const timestamp = new Date().toLocaleString("zh-CN");
      const newContent = existing 
        ? `${existing}\n\n---\n\n【${timestamp}】\n${summary.trim()}`
        : `【${timestamp}】\n${summary.trim()}`;
      
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
        const saved = await saveToWorldbook(settings.bigSummaryEntryName, result.trim());
        
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
          <div class="menu_button" id="chat_summary_gen_small" style="margin-top:10px;">✨ 生成小总结</div>
        </div>
        
        <hr>
        
        <div class="chat-summary-section">
          <b>📚 大总结</b>
          <div class="menu_button" id="chat_summary_gen_big" style="margin-top:8px;">📚 生成大总结</div>
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
