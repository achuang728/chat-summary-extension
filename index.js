import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../../script.js";

const extensionName = "chat-summary-extension";

// 默认设置
const defaultSettings = {
  enabled: true,
  autoSummary: false,
  summaryInterval: 3,
  contextTurns: 5,
  maxChars: 400,
  bigSummaryEnabled: true,
  bigSummaryThreshold: 10,
  bigSummaryKeepCount: 5,
  
  // API设置
  useCustomApi: false,
  apiUrl: "",
  apiKey: "",
  apiModel: "",
  availableModels: [],
  
  // 世界书设置
  selectedWorldbook: "",
  smallSummaryEntryName: "小总结",
  bigSummaryEntryName: "大总结",
  
  currentTurn: 0,
  summaries: []
};

// 提示词
const SMALL_SUMMARY_PROMPT = `你是剧情记录助手。请根据以下对话内容，生成简洁的剧情总结。

要求：
1. 客观记录发生的事件、对话、人物行动
2. 保留关键信息（人物、地点、重要对话）
3. 使用第三人称
4. 字数控制在{{maxChars}}字以内
5. 直接输出总结内容，不要任何前缀说明

对话内容：
{{chatContent}}`;

const BIG_SUMMARY_PROMPT = `你是剧情归纳助手。请将以下多条剧情总结合并精简为{{keepCount}}条核心总结。

要求：
1. 保留最重要的剧情发展
2. 合并相似或连续的事件
3. 每条总结300-500字
4. 保持时间顺序
5. 每条总结前加编号如 [1] [2] [3]

现有总结：
{{summaries}}

请输出合并后的{{keepCount}}条总结：`;

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

// 使用自定义API调用
async function callCustomApi(prompt) {
  const settings = getSettings();
  
  if (!settings.apiUrl || !settings.apiKey || !settings.apiModel) {
    throw new Error("请先配置API地址、密钥和模型");
  }
  
  const response = await fetch(settings.apiUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.apiModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000
    })
  });
  
  if (!response.ok) {
    throw new Error(`API请求失败: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// 拉取可用模型
async function fetchModels() {
  const settings = getSettings();
  
  if (!settings.apiUrl || !settings.apiKey) {
    toastr.warning("请先填写API地址和密钥", "聊天总结");
    return;
  }
  
  try {
    toastr.info("正在获取模型列表...", "聊天总结");
    
    const response = await fetch(settings.apiUrl + "/v1/models", {
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    
    const data = await response.json();
    const models = data.data.map(m => m.id).sort();
    
    settings.availableModels = models;
    saveSettings();
    
    // 更新下拉框
    const $select = $("#chat_summary_model");
    $select.empty();
    $select.append(`<option value="">-- 选择模型 --</option>`);
    models.forEach(model => {
      $select.append(`<option value="${model}">${model}</option>`);
    });
    
    if (settings.apiModel) {
      $select.val(settings.apiModel);
    }
    
    toastr.success(`获取到 ${models.length} 个模型`, "聊天总结");
  } catch (e) {
    toastr.error("获取模型失败: " + e.message, "聊天总结");
  }
}

// 调用AI（根据设置选择API）
async function callAI(prompt) {
  const settings = getSettings();
  
  if (settings.useCustomApi) {
    return await callCustomApi(prompt);
  } else {
    const context = getContext();
    return await context.generateQuietPrompt(prompt, false, false);
  }
}

// ============ 世界书操作 ============

// 获取所有世界书
async function getWorldbooks() {
  try {
    const response = await fetch("/api/worldinfo/list");
    if (!response.ok) return [];
    const data = await response.json();
    return data || [];
  } catch (e) {
    console.error("[聊天总结] 获取世界书列表失败:", e);
    return [];
  }
}

// 更新世界书下拉框
async function updateWorldbookSelect() {
  const worldbooks = await getWorldbooks();
  const settings = getSettings();
  const $select = $("#chat_summary_worldbook");
  
  $select.empty();
  $select.append(`<option value="">-- 选择世界书 --</option>`);
  
  worldbooks.forEach(wb => {
    const name = typeof wb === 'string' ? wb : wb.name;
    $select.append(`<option value="${name}">${name}</option>`);
  });
  
  if (settings.selectedWorldbook) {
    $select.val(settings.selectedWorldbook);
  }
}

// 保存内容到世界书条目
async function saveToWorldbook(entryName, content) {
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return false;
  }
  
  try {
    // 获取世界书条目
    const response = await fetch(`/api/worldinfo/get?name=${encodeURIComponent(settings.selectedWorldbook)}`);
    if (!response.ok) {
      throw new Error("无法获取世界书");
    }
    
    const worldbook = await response.json();
    const entries = worldbook.entries || {};
    
    // 查找或创建条目
    let targetEntry = null;
    let targetUid = null;
    
    for (const [uid, entry] of Object.entries(entries)) {
      if (entry.comment === entryName || entry.key?.includes(entryName)) {
        targetEntry = entry;
        targetUid = uid;
        break;
      }
    }
    
    if (targetEntry) {
      // 更新现有条目
      targetEntry.content = content;
    } else {
      // 创建新条目
      const newUid = Date.now().toString();
      entries[newUid] = {
        uid: newUid,
        key: [entryName],
        keysecondary: [],
        comment: entryName,
        content: content,
        constant: false,
        selective: false,
        order: 100,
        position: 4,
        disable: false,
        excludeRecursion: true,
        probability: 100,
        depth: 4
      };
    }
    
    // 保存世界书
    const saveResponse = await fetch("/api/worldinfo/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: settings.selectedWorldbook,
        data: { entries }
      })
    });
    
    if (!saveResponse.ok) {
      throw new Error("保存失败");
    }
    
    return true;
  } catch (e) {
    console.error("[聊天总结] 保存到世界书失败:", e);
    toastr.error("保存到世界书失败: " + e.message, "聊天总结");
    return false;
  }
}

// 从世界书读取小总结
async function readSmallSummariesFromWorldbook() {
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    return null;
  }
  
  try {
    const response = await fetch(`/api/worldinfo/get?name=${encodeURIComponent(settings.selectedWorldbook)}`);
    if (!response.ok) return null;
    
    const worldbook = await response.json();
    const entries = worldbook.entries || {};
    
    for (const [uid, entry] of Object.entries(entries)) {
      if (entry.comment === settings.smallSummaryEntryName || entry.key?.includes(settings.smallSummaryEntryName)) {
        return entry.content;
      }
    }
    
    return null;
  } catch (e) {
    console.error("[聊天总结] 读取世界书失败:", e);
    return null;
  }
}

// ============ 预览功能 ============

function getPreviewContent() {
  const context = getContext();
  const chat = context.chat;
  const settings = getSettings();
  
  if (!chat || chat.length < 1) {
    return "暂无对话内容";
  }
  
  const turns = settings.contextTurns * 2;
  const recent = chat.slice(-Math.min(turns, chat.length));
  
  let content = "";
  recent.forEach(msg => {
    const role = msg.is_user ? "👤 用户" : "🤖 AI";
    const text = (msg.mes || "").substring(0, 500);
    if (text.trim()) {
      content += `${role}:\n${text}\n\n`;
    }
  });
  
  return content || "暂无对话内容";
}

function showPreview() {
  const content = getPreviewContent();
  $("#chat_summary_preview").text(content);
  toastr.info(`已加载最近 ${getSettings().contextTurns} 轮对话`, "聊天总结");
}

// ============ 核心功能 ============

// 生成小总结
async function generateSmallSummary() {
  if (isProcessing) {
    toastr.warning("正在处理中...", "聊天总结");
    return;
  }
  
  const context = getContext();
  const chat = context.chat;
  
  if (!chat || chat.length < 2) {
    toastr.warning("对话记录不足", "聊天总结");
    return;
  }
  
  isProcessing = true;
  toastr.info("正在生成小总结...", "聊天总结");
  
  try {
    const settings = getSettings();
    const turns = settings.contextTurns * 2;
    const recent = chat.slice(-Math.min(turns, chat.length));
    
    let chatContent = "";
    recent.forEach(msg => {
      const role = msg.is_user ? "用户" : "AI";
      const content = (msg.mes || "").substring(0, 2000);
      if (content.trim()) {
        chatContent += `【${role}】${content}\n\n`;
      }
    });
    
    if (!chatContent.trim()) {
      toastr.warning("没有有效的对话内容", "聊天总结");
      isProcessing = false;
      return;
    }
    
    const prompt = SMALL_SUMMARY_PROMPT
      .replace("{{maxChars}}", settings.maxChars)
      .replace("{{chatContent}}", chatContent);
    
    const summary = await callAI(prompt);
    
    if (summary && summary.trim()) {
      // 保存到内存
      if (!settings.summaries) settings.summaries = [];
      const newSummary = {
        id: Date.now(),
        time: new Date().toLocaleString("zh-CN"),
        content: summary.trim(),
        isMerged: false
      };
      settings.summaries.push(newSummary);
      
      // 保存到世界书
      const allSmallSummaries = settings.summaries
        .filter(s => !s.isMerged)
        .map((s, i) => `[${i + 1}] (${s.time})\n${s.content}`)
        .join("\n\n---\n\n");
      
      await saveToWorldbook(settings.smallSummaryEntryName, allSmallSummaries);
      
      saveSettings();
      updateUI();
      
      toastr.success(`小总结已生成并保存（共${settings.summaries.length}条）`, "聊天总结");
      
      // 检查大总结
      if (settings.bigSummaryEnabled && settings.summaries.filter(s => !s.isMerged).length >= settings.bigSummaryThreshold) {
        toastr.info("达到阈值，可以生成大总结了", "聊天总结");
      }
    }
  } catch (e) {
    toastr.error("生成失败: " + e.message, "聊天总结");
  } finally {
    isProcessing = false;
  }
}

// 生成大总结（从世界书读取小总结）
async function generateBigSummary() {
  if (isProcessing) return;
  
  const settings = getSettings();
  
  // 从世界书读取小总结
  const smallSummariesContent = await readSmallSummariesFromWorldbook();
  
  if (!smallSummariesContent) {
    toastr.warning("世界书中没有找到小总结内容", "聊天总结");
    return;
  }
  
  isProcessing = true;
  toastr.info("正在生成大总结...", "聊天总结");
  
  try {
    const prompt = BIG_SUMMARY_PROMPT
      .replace(/\{\{keepCount\}\}/g, settings.bigSummaryKeepCount)
      .replace("{{summaries}}", smallSummariesContent);
    
    const result = await callAI(prompt);
    
    if (result && result.trim()) {
      // 保存大总结到世界书
      await saveToWorldbook(settings.bigSummaryEntryName, result.trim());
      
      toastr.success("大总结已生成并保存到世界书", "聊天总结");
      updateUI();
    }
  } catch (e) {
    toastr.error("生成失败: " + e.message, "聊天总结");
  } finally {
    isProcessing = false;
  }
}

// 消息事件
function onMessageReceived() {
  const settings = getSettings();
  if (!settings || !settings.enabled || !settings.autoSummary) return;
  
  settings.currentTurn++;
  if (settings.currentTurn >= settings.summaryInterval) {
    settings.currentTurn = 0;
    saveSettings();
    setTimeout(() => generateSmallSummary(), 1500);
  } else {
    saveSettings();
  }
  updateUI();
}

// 清空
function clearSummaries() {
  if (!confirm("确定清空所有总结？")) return;
  const settings = getSettings();
  settings.summaries = [];
  settings.currentTurn = 0;
  saveSettings();
  updateUI();
  toastr.success("已清空", "聊天总结");
}

// ============ UI ============

function updateUI() {
  const settings = getSettings();
  if (!settings) return;
  
  $("#chat_summary_enabled").prop("checked", settings.enabled);
  $("#chat_summary_auto").prop("checked", settings.autoSummary);
  $("#chat_summary_interval").val(settings.summaryInterval);
  $("#chat_summary_context").val(settings.contextTurns);
  $("#chat_summary_threshold").val(settings.bigSummaryThreshold);
  $("#chat_summary_keep").val(settings.bigSummaryKeepCount);
  
  $("#chat_summary_use_custom_api").prop("checked", settings.useCustomApi);
  $("#chat_summary_api_url").val(settings.apiUrl);
  $("#chat_summary_api_key").val(settings.apiKey);
  
  $("#chat_summary_small_entry").val(settings.smallSummaryEntryName);
  $("#chat_summary_big_entry").val(settings.bigSummaryEntryName);
  
  // 显示/隐藏API设置
  if (settings.useCustomApi) {
    $("#chat_summary_api_settings").show();
  } else {
    $("#chat_summary_api_settings").hide();
  }
  
  // 模型下拉框
  if (settings.availableModels && settings.availableModels.length > 0) {
    const $select = $("#chat_summary_model");
    if ($select.children().length <= 1) {
      settings.availableModels.forEach(model => {
        $select.append(`<option value="${model}">${model}</option>`);
      });
    }
    if (settings.apiModel) {
      $select.val(settings.apiModel);
    }
  }
  
  $("#chat_summary_turns").text(`${settings.currentTurn}/${settings.summaryInterval}`);
  $("#chat_summary_count").text(settings.summaries ? settings.summaries.length : 0);
}

function createUI() {
  const html = `
  <div id="chat_summary_panel" class="chat-summary-panel">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>📝 聊天总结助手</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        
        <!-- 状态 -->
        <div class="chat-summary-status">
          <div class="chat-summary-stat">
            <span class="stat-value" id="chat_summary_turns">0/3</span>
            <span class="stat-label">当前轮数</span>
          </div>
          <div class="chat-summary-stat">
            <span class="stat-value" id="chat_summary_count">0</span>
            <span class="stat-label">已保存</span>
          </div>
        </div>
        
        <!-- 基本开关 -->
        <div class="chat-summary-section">
          <div class="chat-summary-row">
            <label class="checkbox_label">
              <input type="checkbox" id="chat_summary_enabled">
              <span>启用扩展</span>
            </label>
          </div>
          <div class="chat-summary-row">
            <label class="checkbox_label">
              <input type="checkbox" id="chat_summary_auto">
              <span>自动生成小总结</span>
            </label>
          </div>
        </div>
        
        <!-- API设置 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">🔌 API设置</div>
          <div class="chat-summary-row">
            <label class="checkbox_label">
              <input type="checkbox" id="chat_summary_use_custom_api">
              <span>使用独立API</span>
            </label>
          </div>
          <div id="chat_summary_api_settings" style="display: none;">
            <div class="chat-summary-row">
              <label>API地址</label>
              <input type="text" id="chat_summary_api_url" class="text_pole" placeholder="https://api.example.com">
            </div>
            <div class="chat-summary-row">
              <label>API密钥</label>
              <input type="password" id="chat_summary_api_key" class="text_pole" placeholder="sk-xxx">
            </div>
            <div class="chat-summary-row">
              <label>模型</label>
              <select id="chat_summary_model" class="text_pole">
                <option value="">-- 选择模型 --</option>
              </select>
            </div>
            <div class="chat-summary-row">
              <div class="menu_button" id="chat_summary_fetch_models">🔄 获取模型列表</div>
            </div>
          </div>
        </div>
        
        <!-- 小总结设置 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">📌 小总结设置</div>
          <div class="chat-summary-row">
            <label>每隔N轮生成</label>
            <input type="number" id="chat_summary_interval" class="text_pole" min="1" max="20" value="3">
          </div>
          <div class="chat-summary-row">
            <label>读取N轮对话</label>
            <input type="number" id="chat_summary_context" class="text_pole" min="1" max="20" value="5">
          </div>
        </div>
        
        <!-- 大总结设置 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">📚 大总结设置</div>
          <div class="chat-summary-row">
            <label>触发阈值(条)</label>
            <input type="number" id="chat_summary_threshold" class="text_pole" min="3" max="50" value="10">
          </div>
          <div class="chat-summary-row">
            <label>精简后保留</label>
            <input type="number" id="chat_summary_keep" class="text_pole" min="1" max="20" value="5">
          </div>
        </div>
        
        <!-- 世界书设置 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">📖 世界书设置</div>
          <div class="chat-summary-row">
            <label>目标世界书</label>
            <select id="chat_summary_worldbook" class="text_pole">
              <option value="">-- 选择世界书 --</option>
            </select>
          </div>
          <div class="chat-summary-row">
            <div class="menu_button" id="chat_summary_refresh_wb">🔄 刷新列表</div>
          </div>
          <div class="chat-summary-row">
            <label>小总结条目名</label>
            <input type="text" id="chat_summary_small_entry" class="text_pole" value="小总结">
          </div>
          <div class="chat-summary-row">
            <label>大总结条目名</label>
            <input type="text" id="chat_summary_big_entry" class="text_pole" value="大总结">
          </div>
        </div>
        
        <!-- 预览 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">👁️ 待总结内容预览</div>
          <div class="chat-summary-row">
            <div class="menu_button" id="chat_summary_show_preview">📄 查看待总结内容</div>
          </div>
          <div class="chat-summary-preview" id="chat_summary_preview">点击上方按钮查看</div>
        </div>
        
        <!-- 操作按钮 -->
        <div class="chat-summary-buttons">
          <div class="menu_button" id="chat_summary_gen_small">✨ 生成小总结</div>
          <div class="menu_button" id="chat_summary_gen_big">📚 生成大总结</div>
        </div>
        <div class="chat-summary-buttons">
          <div class="menu_button menu_button_danger" id="chat_summary_clear">🗑️ 清空总结</div>
        </div>
        
      </div>
    </div>
  </div>`;
  
  $("#extensions_settings").append(html);
  console.log("[聊天总结助手] UI已创建");
}

function bindEvents() {
  const settings = getSettings();
  
  // 基本开关
  $("#chat_summary_enabled").on("change", function() {
    settings.enabled = $(this).prop("checked");
    saveSettings();
  });
  
  $("#chat_summary_auto").on("change", function() {
    settings.autoSummary = $(this).prop("checked");
    saveSettings();
  });
  
  // API设置
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
  
  $("#chat_summary_model").on("change", function() {
    settings.apiModel = $(this).val();
    saveSettings();
  });
  
  $("#chat_summary_fetch_models").on("click", fetchModels);
  
  // 小总结设置
  $("#chat_summary_interval").on("change", function() {
    settings.summaryInterval = parseInt($(this).val()) || 3;
    saveSettings();
    updateUI();
  });
  
  $("#chat_summary_context").on("change", function() {
    settings.contextTurns = parseInt($(this).val()) || 5;
    saveSettings();
  });
  
  // 大总结设置
  $("#chat_summary_threshold").on("change", function() {
    settings.bigSummaryThreshold = parseInt($(this).val()) || 10;
    saveSettings();
  });
  
  $("#chat_summary_keep").on("change", function() {
    settings.bigSummaryKeepCount = parseInt($(this).val()) || 5;
    saveSettings();
  });
  
  // 世界书设置
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
  
  // 预览
  $("#chat_summary_show_preview").on("click", showPreview);
  
  // 操作按钮
  $("#chat_summary_gen_small").on("click", generateSmallSummary);
  $("#chat_summary_gen_big").on("click", generateBigSummary);
  $("#chat_summary_clear").on("click", clearSummaries);
  
  console.log("[聊天总结助手] 事件已绑定");
}

// 初始化
jQuery(async () => {
  console.log("[聊天总结助手] 开始加载...");
  
  createUI();
  loadSettings();
  bindEvents();
  
  // 初始化世界书列表
  await updateWorldbookSelect();
  
  // 监听消息事件
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  
  console.log("[聊天总结助手] 扩展已加载完成");
});
