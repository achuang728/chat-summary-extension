import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

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

async function callAI(prompt) {
  const context = getContext();
  return await context.generateQuietPrompt(prompt, false, false);
}

// ============ 世界书操作 ============

async function getWorldbooks() {
  const worldbookList = [];
  
  // 从世界书下拉框获取
  try {
    $("#world_info option, #world_editor_select option").each(function() {
      const val = $(this).val();
      const text = $(this).text().trim();
      if (val && text && val !== "" && text !== "None" && text !== "无" && !text.includes("选择")) {
        if (!worldbookList.find(w => w.name === val)) {
          worldbookList.push({ name: val, displayName: text });
        }
      }
    });
  } catch (e) {
    console.log("[聊天总结] DOM获取失败:", e.message);
  }
  
  // 从角色世界书获取
  try {
    const context = getContext();
    if (context.characters && context.characterId !== undefined) {
      const char = context.characters[context.characterId];
      if (char?.data?.extensions?.world) {
        const charWorld = char.data.extensions.world;
        if (charWorld && !worldbookList.find(w => w.name === charWorld)) {
          worldbookList.push({ name: charWorld, displayName: `${charWorld} (角色)` });
        }
      }
    }
  } catch (e) {
    console.log("[聊天总结] 角色世界书获取失败:", e.message);
  }
  
  console.log("[聊天总结] 找到世界书:", worldbookList);
  return worldbookList;
}

async function updateWorldbookSelect() {
  const settings = getSettings();
  const $select = $("#chat_summary_worldbook");
  
  $select.empty();
  $select.append(`<option value="">-- 选择世界书 --</option>`);
  
  toastr.info("正在获取世界书列表...", "聊天总结");
  
  const worldbooks = await getWorldbooks();
  
  if (worldbooks.length === 0) {
    toastr.warning("未找到世界书", "聊天总结");
    return;
  }
  
  worldbooks.forEach(wb => {
    $select.append(`<option value="${wb.name}">${wb.displayName}</option>`);
  });
  
  if (settings.selectedWorldbook) {
    $select.val(settings.selectedWorldbook);
  }
  
  toastr.success(`找到 ${worldbooks.length} 个世界书`, "聊天总结");
}

// 获取世界书数据
async function getWorldbookData(worldbookName) {
  try {
    const response = await fetch("/api/worldinfo/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: worldbookName })
    });
    
    if (response.ok) {
      return await response.json();
    }
    
    console.log("[聊天总结] POST方式获取失败，尝试其他方式");
  } catch (e) {
    console.log("[聊天总结] 获取世界书失败:", e.message);
  }
  
  return null;
}

// 保存世界书条目
async function saveToWorldbook(entryName, content) {
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return false;
  }
  
  const worldbookName = settings.selectedWorldbook;
  console.log("[聊天总结] 准备保存到世界书:", worldbookName, "条目:", entryName);
  
  try {
    // 获取世界书数据
    const worldbook = await getWorldbookData(worldbookName);
    
    if (!worldbook) {
      console.log("[聊天总结] 无法获取世界书数据，尝试直接创建条目");
      return await createEntryDirectly(worldbookName, entryName, content);
    }
    
    const entries = worldbook.entries || {};
    let foundUid = null;
    
    // 查找已存在的条目
    for (const [uid, entry] of Object.entries(entries)) {
      const comment = entry.comment || "";
      const keys = entry.key || [];
      if (comment === entryName || keys.includes(entryName)) {
        foundUid = uid;
        console.log("[聊天总结] 找到已存在的条目, uid:", uid);
        break;
      }
    }
    
    if (foundUid) {
      // 更新现有条目
      entries[foundUid].content = content;
    } else {
      // 创建新条目
      const newUid = Object.keys(entries).length;
      entries[newUid] = {
        uid: newUid,
        key: [entryName],
        keysecondary: [],
        comment: entryName,
        content: content,
        constant: true,
        selective: false,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: "",
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        automationId: "",
        role: null,
        vectorized: false,
        displayIndex: Object.keys(entries).length,
      };
      console.log("[聊天总结] 创建新条目, uid:", newUid);
    }
    
    // 保存到服务器
    const saveResponse = await fetch("/api/worldinfo/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: worldbookName,
        data: { entries: entries }
      })
    });
    
    if (saveResponse.ok) {
      console.log("[聊天总结] 保存成功 (edit API)");
      return true;
    }
    
    console.log("[聊天总结] edit API失败，状态:", saveResponse.status);
    
    // 尝试其他保存方式
    return await createEntryDirectly(worldbookName, entryName, content);
    
  } catch (e) {
    console.error("[聊天总结] 保存出错:", e);
    return await createEntryDirectly(worldbookName, entryName, content);
  }
}

// 直接创建/更新条目（备用方法）
async function createEntryDirectly(worldbookName, entryName, content) {
  console.log("[聊天总结] 尝试直接创建条目方式");
  
  // 方法1: 使用 update-entry API
  try {
    const response = await fetch("/api/worldinfo/update-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: worldbookName,
        uid: entryName,
        key: entryName,
        comment: entryName,
        content: content,
        constant: true
      })
    });
    
    if (response.ok) {
      console.log("[聊天总结] update-entry 成功");
      return true;
    }
  } catch (e) {
    console.log("[聊天总结] update-entry 失败:", e.message);
  }
  
  // 方法2: 使用 create-entry API
  try {
    const response = await fetch("/api/worldinfo/create-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: worldbookName,
        key: entryName,
        comment: entryName,
        content: content,
        constant: true
      })
    });
    
    if (response.ok) {
      console.log("[聊天总结] create-entry 成功");
      return true;
    }
  } catch (e) {
    console.log("[聊天总结] create-entry 失败:", e.message);
  }
  
  // 方法3: 使用文件保存API
  try {
    const worldbook = await getWorldbookData(worldbookName) || { entries: {} };
    const entries = worldbook.entries || {};
    
    // 添加或更新条目
    let found = false;
    for (const uid in entries) {
      if (entries[uid].comment === entryName || (entries[uid].key && entries[uid].key.includes(entryName))) {
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
    
    // 尝试直接写入文件
    const response = await fetch("/api/worldinfo/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: worldbookName,
        entries: entries
      })
    });
    
    if (response.ok) {
      console.log("[聊天总结] save API 成功");
      return true;
    }
  } catch (e) {
    console.log("[聊天总结] save API 失败:", e.message);
  }
  
  // 全部失败，弹出手动复制窗口
  console.log("[聊天总结] 所有自动保存方式失败，显示手动复制窗口");
  toastr.warning("自动保存失败，请手动复制", "聊天总结");
  showCopyPopup(entryName, content);
  return false;
}

// 显示复制弹窗
function showCopyPopup(title, content) {
  $("#chat_summary_popup_overlay").remove();
  
  const popup = `
    <div id="chat_summary_popup_overlay" style="
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
    ">
      <div style="
        background: #1e1e2e;
        border-radius: 12px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      ">
        <div style="
          padding: 16px 20px;
          background: linear-gradient(135deg, #f39c12, #e74c3c);
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <span style="font-weight: 600; font-size: 16px;">📋 请手动复制到世界书「${escapeHtml(title)}」条目</span>
          <button id="chat_summary_popup_close" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 18px;
          ">×</button>
        </div>
        <div style="
          padding: 16px;
          overflow-y: auto;
          flex: 1;
          font-size: 14px;
          line-height: 1.6;
          white-space: pre-wrap;
          color: #e0e0e0;
          user-select: text;
        ">${escapeHtml(content)}</div>
        <div style="
          padding: 16px;
          display: flex;
          gap: 12px;
          border-top: 1px solid rgba(255,255,255,0.1);
        ">
          <button id="chat_summary_copy_btn" style="
            flex: 1;
            padding: 12px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            border: none;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
          ">📋 复制内容</button>
          <button id="chat_summary_popup_cancel" style="
            flex: 1;
            padding: 12px;
            background: #444;
            border: none;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            font-size: 14px;
          ">关闭</button>
        </div>
      </div>
    </div>
  `;
  
  $("body").append(popup);
  
  $("#chat_summary_popup_close, #chat_summary_popup_cancel").on("click", function() {
    $("#chat_summary_popup_overlay").remove();
  });
  
  $("#chat_summary_copy_btn").on("click", function() {
    navigator.clipboard.writeText(content).then(() => {
      toastr.success("已复制到剪贴板", "聊天总结");
    }).catch(() => {
      toastr.error("复制失败，请手动选择复制", "聊天总结");
    });
  });
}

// 从世界书读取条目内容
async function readFromWorldbook(entryName) {
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    return null;
  }
  
  const worldbookName = settings.selectedWorldbook;
  console.log("[聊天总结] 从世界书读取:", worldbookName, "条目:", entryName);
  
  try {
    const worldbook = await getWorldbookData(worldbookName);
    
    if (!worldbook || !worldbook.entries) {
      console.log("[聊天总结] 世界书数据为空");
      return null;
    }
    
    const entries = worldbook.entries;
    
    for (const [uid, entry] of Object.entries(entries)) {
      const comment = entry.comment || "";
      const keys = entry.key || [];
      if (comment === entryName || keys.includes(entryName)) {
        console.log("[聊天总结] 找到条目:", uid, "内容长度:", entry.content?.length);
        return entry.content;
      }
    }
    
    console.log("[聊天总结] 未找到条目:", entryName);
    return null;
  } catch (e) {
    console.error("[聊天总结] 读取世界书失败:", e);
    return null;
  }
}

// ============ 楼层选择和内容处理 ============

function parseFloorRange(rangeStr) {
  const parts = rangeStr.split("-");
  if (parts.length !== 2) {
    return { start: 0, end: 10 };
  }
  const start = parseInt(parts[0].trim()) || 0;
  const end = parseInt(parts[1].trim()) || 10;
  return { start, end };
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
    
    // 排除指定内容
    if (settings.excludePattern && settings.excludePattern.trim()) {
      try {
        const regex = new RegExp(settings.excludePattern, "gi");
        content = content.replace(regex, "");
      } catch (e) {
        console.error("[聊天总结] 正则表达式错误:", e);
      }
    }
    
    content = content.trim();
    if (content) {
      const role = msg.is_user ? "👤 用户" : "🤖 AI";
      messages.push({
        floor: i,
        role: role,
        name: msg.name || role,
        content: content
      });
    }
  }
  
  const formattedContent = messages.map(m => 
    `【第${m.floor}楼 - ${m.name}】\n${m.content}`
  ).join("\n\n---\n\n");
  
  return { content: formattedContent, messages };
}

// ============ 弹窗预览 ============

function showPreviewPopup(content, onConfirm) {
  $("#chat_summary_popup_overlay").remove();
  
  const popup = `
    <div id="chat_summary_popup_overlay" style="
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
    ">
      <div style="
        background: #1e1e2e;
        border-radius: 12px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      ">
        <div style="
          padding: 16px 20px;
          background: linear-gradient(135deg, #667eea, #764ba2);
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <span style="font-weight: 600; font-size: 16px;">📄 待总结内容预览</span>
          <button id="chat_summary_popup_close" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 18px;
          ">×</button>
        </div>
        <div style="
          padding: 16px;
          overflow-y: auto;
          flex: 1;
          font-size: 14px;
          line-height: 1.6;
          white-space: pre-wrap;
          color: #e0e0e0;
        ">${escapeHtml(content) || "没有选中任何内容"}</div>
        <div style="
          padding: 16px;
          display: flex;
          gap: 12px;
          border-top: 1px solid rgba(255,255,255,0.1);
        ">
          <button id="chat_summary_popup_cancel" style="
            flex: 1;
            padding: 12px;
            background: #444;
            border: none;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            font-size: 14px;
          ">取消</button>
          <button id="chat_summary_popup_confirm" style="
            flex: 1;
            padding: 12px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            border: none;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
          ">✨ 开始总结</button>
        </div>
      </div>
    </div>
  `;
  
  $("body").append(popup);
  
  $("#chat_summary_popup_close, #chat_summary_popup_cancel").on("click", function() {
    $("#chat_summary_popup_overlay").remove();
  });
  
  $("#chat_summary_popup_confirm").on("click", function() {
    $("#chat_summary_popup_overlay").remove();
    if (onConfirm) onConfirm();
  });
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============ 核心功能 ============

function previewSmallSummary() {
  const { content, messages } = getSelectedContent();
  
  if (!content || messages.length === 0) {
    toastr.warning("选中的楼层范围没有内容", "聊天总结");
    return;
  }
  
  showPreviewPopup(content, async () => {
    await generateSmallSummary(content);
  });
}

async function generateSmallSummary(content) {
  if (isProcessing) {
    toastr.warning("正在处理中...", "聊天总结");
    return;
  }
  
  if (!content) {
    const { content: c } = getSelectedContent();
    content = c;
  }
  
  if (!content) {
    toastr.warning("没有内容可总结", "聊天总结");
    return;
  }
  
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
      // 读取现有小总结
      let existingSummaries = await readFromWorldbook(settings.smallSummaryEntryName) || "";
      
      // 添加新总结
      const timestamp = new Date().toLocaleString("zh-CN");
      const newEntry = existingSummaries 
        ? `${existingSummaries}\n\n---\n\n【${timestamp}】\n${summary.trim()}`
        : `【${timestamp}】\n${summary.trim()}`;
      
      // 保存到世界书
      const saved = await saveToWorldbook(settings.smallSummaryEntryName, newEntry);
      
      if (saved) {
        toastr.success("小总结已生成并保存到世界书", "聊天总结");
      }
    } else {
      toastr.warning("AI返回内容为空", "聊天总结");
    }
  } catch (e) {
    toastr.error("生成失败: " + e.message, "聊天总结");
    console.error("[聊天总结] 生成小总结失败:", e);
  } finally {
    isProcessing = false;
  }
}

async function generateBigSummary() {
  if (isProcessing) {
    toastr.warning("正在处理中...", "聊天总结");
    return;
  }
  
  const settings = getSettings();
  
  if (!settings.selectedWorldbook) {
    toastr.warning("请先选择目标世界书", "聊天总结");
    return;
  }
  
  // 从世界书读取小总结
  const smallSummaries = await readFromWorldbook(settings.smallSummaryEntryName);
  
  if (!smallSummaries) {
    toastr.warning("世界书中没有找到小总结内容，请先生成小总结", "聊天总结");
    return;
  }
  
  // 显示预览
  showPreviewPopup(smallSummaries, async () => {
    isProcessing = true;
    toastr.info("正在生成大总结...", "聊天总结");
    
    try {
      const prompt = BIG_SUMMARY_PROMPT.replace("{{summaries}}", smallSummaries);
      const result = await callAI(prompt);
      
      if (result && result.trim()) {
        const saved = await saveToWorldbook(settings.bigSummaryEntryName, result.trim());
        
        if (saved) {
          toastr.success("大总结已生成并保存到世界书", "聊天总结");
        }
      } else {
        toastr.warning("AI返回内容为空", "聊天总结");
      }
    } catch (e) {
      toastr.error("生成失败: " + e.message, "聊天总结");
      console.error("[聊天总结] 生成大总结失败:", e);
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
  $("#chat_summary_floor_range").val(settings.floorRange);
  $("#chat_summary_exclude").val(settings.excludePattern);
  $("#chat_summary_small_entry").val(settings.smallSummaryEntryName);
  $("#chat_summary_big_entry").val(settings.bigSummaryEntryName);
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
        
        <!-- 基本开关 -->
        <div class="chat-summary-section">
          <div class="chat-summary-row">
            <label class="checkbox_label">
              <input type="checkbox" id="chat_summary_enabled" checked>
              <span>启用扩展</span>
            </label>
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
        
        <!-- 小总结设置 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">📌 小总结设置</div>
          <div class="chat-summary-row">
            <label>选择楼层范围</label>
            <input type="text" id="chat_summary_floor_range" class="text_pole" placeholder="0-10" value="0-10">
          </div>
          <div class="chat-summary-row">
            <label>排除内容(正则)</label>
            <input type="text" id="chat_summary_exclude" class="text_pole" placeholder="<thinking>[\\s\\S]*?</thinking>">
          </div>
          <div class="chat-summary-row">
            <div class="menu_button" id="chat_summary_gen_small">✨ 生成小总结</div>
          </div>
        </div>
        
        <!-- 大总结 -->
        <div class="chat-summary-section">
          <div class="chat-summary-section-title">📚 大总结</div>
          <div class="chat-summary-row">
            <div class="menu_button" id="chat_summary_gen_big">📚 生成大总结</div>
          </div>
          <p style="font-size: 12px; opacity: 0.7; margin-top: 5px;">从世界书的小总结条目读取内容进行合并</p>
        </div>
        
        <p style="font-size: 11px; opacity: 0.5; margin-top: 10px;">使用酒馆已连接的API生成总结</p>
        
      </div>
    </div>
  </div>`;
  
  $("#extensions_settings").append(html);
  console.log("[聊天总结助手] UI已创建");
}

function bindEvents() {
  const settings = getSettings();
  
  $("#chat_summary_enabled").on("change", function() {
    settings.enabled = $(this).prop("checked");
    saveSettings();
  });
  
  // 小总结设置
  $("#chat_summary_floor_range").on("change", function() {
    settings.floorRange = $(this).val() || "0-10";
    saveSettings();
  });
  
  $("#chat_summary_exclude").on("change", function() {
    settings.excludePattern = $(this).val();
    saveSettings();
  });
  
  // 世界书设置
  $("#chat_summary_worldbook").on("change", function() {
    settings.selectedWorldbook = $(this).val();
    saveSettings();
    console.log("[聊天总结] 选择世界书:", settings.selectedWorldbook);
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
  
  // 操作按钮
  $("#chat_summary_gen_small").on("click", previewSmallSummary);
  $("#chat_summary_gen_big").on("click", generateBigSummary);
  
  console.log("[聊天总结助手] 事件已绑定");
}

// 初始化
jQuery(async () => {
  console.log("[聊天总结助手] 开始加载...");
  
  createUI();
  loadSettings();
  bindEvents();
  
  // 延迟初始化世界书列表
  setTimeout(async () => {
    await updateWorldbookSelect();
  }, 2000);
  
  console.log("[聊天总结助手] 扩展已加载完成");
});
