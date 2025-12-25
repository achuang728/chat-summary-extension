import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../../script.js";

const extensionName = "chat-summary-extension";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 默认设置
const defaultSettings = {
  enabled: true,
  autoSummary: true,
  summaryInterval: 3,
  contextTurns: 5,
  maxChars: 400,
  bigSummaryEnabled: true,
  bigSummaryThreshold: 10,
  bigSummaryKeepCount: 5,
  worldbookEntryName: "剧情总结",
  worldbookKeywords: "剧情,总结,记忆",
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

// 加载设置
function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
  
  // 确保所有默认值都存在
  for (const key in defaultSettings) {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = defaultSettings[key];
    }
  }
  
  updateUI();
}

// 保存设置
function saveSettings() {
  saveSettingsDebounced();
}

// 更新UI显示
function updateUI() {
  const settings = extension_settings[extensionName];
  if (!settings) return;
  
  $("#chat_summary_enabled").prop("checked", settings.enabled);
  $("#chat_summary_auto").prop("checked", settings.autoSummary);
  $("#chat_summary_interval").val(settings.summaryInterval);
  $("#chat_summary_context").val(settings.contextTurns);
  $("#chat_summary_threshold").val(settings.bigSummaryThreshold);
  $("#chat_summary_keep").val(settings.bigSummaryKeepCount);
  $("#chat_summary_entryname").val(settings.worldbookEntryName);
  $("#chat_summary_keywords").val(settings.worldbookKeywords);
  
  $("#chat_summary_turns").text(`${settings.currentTurn}/${settings.summaryInterval}`);
  $("#chat_summary_count").text(settings.summaries ? settings.summaries.length : 0);
  
  // 预览
  if (settings.summaries && settings.summaries.length > 0) {
    const preview = settings.summaries.slice(-3).map((s, i) => 
      `[${settings.summaries.length - 2 + i}] ${s.content.substring(0, 60)}...`
    ).join("\n\n");
    $("#chat_summary_preview").text(preview);
  } else {
    $("#chat_summary_preview").text("暂无总结");
  }
}

// 调用AI生成
async function callAI(prompt) {
  const context = getContext();
  
  try {
    const response = await context.generateQuietPrompt(prompt, false, false);
    return response;
  } catch (e) {
    console.error("[聊天总结] AI调用失败:", e);
    throw e;
  }
}

// 格式化总结
function formatSummaries() {
  const settings = extension_settings[extensionName];
  
  if (!settings.summaries || settings.summaries.length === 0) {
    return "暂无剧情总结";
  }
  
  let output = `【剧情总结】共${settings.summaries.length}条\n\n`;
  settings.summaries.forEach((s, idx) => {
    const tag = s.isMerged ? "[精简]" : "";
    output += `[${idx + 1}] ${tag}(${s.time})\n${s.content}\n\n---\n\n`;
  });
  
  return output.trim();
}

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
    const settings = extension_settings[extensionName];
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
      if (!settings.summaries) settings.summaries = [];
      
      settings.summaries.push({
        id: Date.now(),
        time: new Date().toLocaleString("zh-CN"),
        content: summary.trim().substring(0, settings.maxChars + 100),
        isMerged: false
      });
      
      saveSettings();
      updateUI();
      
      toastr.success(`小总结已生成（共${settings.summaries.length}条）`, "聊天总结");
      
      // 检查大总结
      if (settings.bigSummaryEnabled && settings.summaries.length >= settings.bigSummaryThreshold) {
        toastr.info("达到阈值，3秒后生成大总结...", "聊天总结");
        setTimeout(() => generateBigSummary(), 3000);
      }
    }
  } catch (e) {
    toastr.error("生成失败: " + e.message, "聊天总结");
  } finally {
    isProcessing = false;
  }
}

// 生成大总结
async function generateBigSummary() {
  if (isProcessing) return;
  
  const settings = extension_settings[extensionName];
  
  if (!settings.summaries || settings.summaries.length < 2) {
    toastr.warning("总结数量不足", "聊天总结");
    return;
  }
  
  isProcessing = true;
  toastr.info("正在生成大总结...", "聊天总结");
  
  try {
    const summariesText = settings.summaries
      .map((s, i) => `[${i + 1}] (${s.time})\n${s.content}`)
      .join("\n\n---\n\n");
    
    const prompt = BIG_SUMMARY_PROMPT
      .replace(/\{\{keepCount\}\}/g, settings.bigSummaryKeepCount)
      .replace("{{summaries}}", summariesText);
    
    const result = await callAI(prompt);
    
    if (result && result.trim()) {
      const newSummaries = [];
      const regex = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
      let match;
      
      while ((match = regex.exec(result)) !== null) {
        const content = match[2].trim();
        if (content) {
          newSummaries.push({
            id: Date.now() + newSummaries.length,
            time: new Date().toLocaleString("zh-CN"),
            content: content,
            isMerged: true
          });
        }
      }
      
      if (newSummaries.length > 0) {
        const oldCount = settings.summaries.length;
        settings.summaries = newSummaries;
        saveSettings();
        updateUI();
        toastr.success(`大总结完成！${oldCount}条 → ${newSummaries.length}条`, "聊天总结");
      }
    }
  } catch (e) {
    toastr.error("生成失败: " + e.message, "聊天总结");
  } finally {
    isProcessing = false;
  }
}

// 消息事件处理
function onMessageReceived() {
  const settings = extension_settings[extensionName];
  
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

// 导出总结
function exportSummaries() {
  const content = formatSummaries();
  
  navigator.clipboard.writeText(content).then(() => {
    toastr.success("已复制到剪贴板", "聊天总结");
  }).catch(() => {
    $("#chat_summary_preview").text(content);
    toastr.info("请手动复制预览区内容", "聊天总结");
  });
}

// 清空总结
function clearSummaries() {
  if (!confirm("确定清空所有总结？")) return;
  
  const settings = extension_settings[extensionName];
  settings.summaries = [];
  settings.currentTurn = 0;
  saveSettings();
  updateUI();
  toastr.success("已清空", "聊天总结");
}

// 创建UI
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
        
        <!-- 开关 -->
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
        
        <!-- 小总结设置 -->
        <div class="chat-summary-row">
          <label>每隔N轮生成</label>
          <input type="number" id="chat_summary_interval" class="text_pole" min="1" max="20" value="3">
        </div>
        
        <div class="chat-summary-row">
          <label>读取N轮对话</label>
          <input type="number" id="chat_summary_context" class="text_pole" min="1" max="20" value="5">
        </div>
        
        <!-- 大总结设置 -->
        <div class="chat-summary-row">
          <label>大总结阈值</label>
          <input type="number" id="chat_summary_threshold" class="text_pole" min="3" max="50" value="10">
        </div>
        
        <div class="chat-summary-row">
          <label>精简后保留</label>
          <input type="number" id="chat_summary_keep" class="text_pole" min="1" max="20" value="5">
        </div>
        
        <!-- 世界书设置 -->
        <div class="chat-summary-row">
          <label>世界书条目名</label>
          <input type="text" id="chat_summary_entryname" class="text_pole" value="剧情总结">
        </div>
        
        <div class="chat-summary-row">
          <label>触发关键词</label>
          <input type="text" id="chat_summary_keywords" class="text_pole" value="剧情,总结,记忆">
        </div>
        
        <!-- 按钮 -->
        <div class="chat-summary-buttons">
          <div class="menu_button" id="chat_summary_gen_small">✨ 生成小总结</div>
          <div class="menu_button" id="chat_summary_gen_big">📚 生成大总结</div>
        </div>
        <div class="chat-summary-buttons">
          <div class="menu_button" id="chat_summary_export">📋 导出总结</div>
          <div class="menu_button menu_button_danger" id="chat_summary_clear">🗑️ 清空</div>
        </div>
        
        <!-- 预览 -->
        <div class="chat-summary-preview-title">总结预览</div>
        <div class="chat-summary-preview" id="chat_summary_preview">暂无总结</div>
        
      </div>
    </div>
  </div>`;
  
  $("#extensions_settings").append(html);
  console.log("[聊天总结助手] UI已创建");
}

// 绑定事件
function bindEvents() {
  const settings = extension_settings[extensionName];
  
  $("#chat_summary_enabled").on("change", function() {
    settings.enabled = $(this).prop("checked");
    saveSettings();
  });
  
  $("#chat_summary_auto").on("change", function() {
    settings.autoSummary = $(this).prop("checked");
    saveSettings();
  });
  
  $("#chat_summary_interval").on("change", function() {
    settings.summaryInterval = parseInt($(this).val()) || 3;
    saveSettings();
    updateUI();
  });
  
  $("#chat_summary_context").on("change", function() {
    settings.contextTurns = parseInt($(this).val()) || 5;
    saveSettings();
  });
  
  $("#chat_summary_threshold").on("change", function() {
    settings.bigSummaryThreshold = parseInt($(this).val()) || 10;
    saveSettings();
  });
  
  $("#chat_summary_keep").on("change", function() {
    settings.bigSummaryKeepCount = parseInt($(this).val()) || 5;
    saveSettings();
  });
  
  $("#chat_summary_entryname").on("change", function() {
    settings.worldbookEntryName = $(this).val() || "剧情总结";
    saveSettings();
  });
  
  $("#chat_summary_keywords").on("change", function() {
    settings.worldbookKeywords = $(this).val() || "剧情,总结";
    saveSettings();
  });
  
  $("#chat_summary_gen_small").on("click", generateSmallSummary);
  $("#chat_summary_gen_big").on("click", generateBigSummary);
  $("#chat_summary_export").on("click", exportSummaries);
  $("#chat_summary_clear").on("click", clearSummaries);
  
  console.log("[聊天总结助手] 事件已绑定");
}

// 初始化
jQuery(async () => {
  console.log("[聊天总结助手] 开始加载...");
  
  createUI();
  loadSettings();
  bindEvents();
  
  // 监听消息事件
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  
  console.log("[聊天总结助手] 扩展已加载完成");
});
