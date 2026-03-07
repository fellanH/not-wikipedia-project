const API_BASE = "http://localhost:3001/api";

let eventSource = null;
let logBuffer = [];
let currentExternalPid = null;
let allTasks = [];
let filteredTasks = [];
let logSearchTerm = "";
let logSearchRegex = false;
let logSearchCaseSensitive = false;
let allUserTasks = [];
let filteredUserTasks = [];
let currentReviewTaskId = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
let followMode = false;
let logBookmarks = new Set();
let searchMatchIndex = -1;
let searchMatches = [];
let virtualScrollEnabled = false;
let lineHeight = 20; // Estimated line height in pixels
let containerHeight = 0;
let logStats = {
  totalLines: 0,
  errorCount: 0,
  warnCount: 0,
  infoCount: 0,
  successCount: 0,
  stdoutCount: 0,
  stderrCount: 0,
};
let detectedTaskIds = new Set();

// Configure marked for markdown rendering
if (typeof marked !== "undefined") {
  marked.setOptions({
    highlight: function (code, lang) {
      if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (err) {}
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true,
  });
}

// DOM elements
const statusBadge = document.getElementById("status-badge");
const pidDisplay = document.getElementById("pid-display");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnRefreshRoadmap = document.getElementById("btn-refresh-roadmap");
const btnRefreshPrompt = document.getElementById("btn-refresh-prompt");
const btnRefreshTasks = document.getElementById("btn-refresh-tasks");
const btnClearLogs = document.getElementById("btn-clear-logs");
const roadmapContent = document.getElementById("roadmap-content");
const promptContent = document.getElementById("prompt-content");
const logsContent = document.getElementById("logs-content");
const tasksContent = document.getElementById("tasks-content");
const logSelect = document.getElementById("log-select");
const taskSearch = document.getElementById("task-search");
const taskStatusFilter = document.getElementById("task-status-filter");
const taskPriorityFilter = document.getElementById("task-priority-filter");
const logSearch = document.getElementById("log-search");
const logLevelFilterEl = document.getElementById("log-level-filter");
const logSearchRegexEl = document.getElementById("log-search-regex");
const logSearchCaseEl = document.getElementById("log-search-case");
const btnExportLogs = document.getElementById("btn-export-logs");
const btnFollowMode = document.getElementById("btn-follow-mode");
const btnCopyLogs = document.getElementById("btn-copy-logs");
const logFontSizeEl = document.getElementById("log-font-size");
const logsContentEl = document.getElementById("logs-content");
const btnLogStats = document.getElementById("btn-log-stats");
const btnWorkerTimeline = document.getElementById("btn-worker-timeline");
const logStatsPanel = document.getElementById("log-stats-panel");
const taskModal = document.getElementById("task-modal");
const modalClose = document.getElementById("modal-close");
const modalTaskId = document.getElementById("modal-task-id");
const modalTaskContent = document.getElementById("modal-task-content");
const btnCreateUserTask = document.getElementById("btn-create-user-task");
const btnRefreshUserTasks = document.getElementById("btn-refresh-user-tasks");
const userTasksContent = document.getElementById("user-tasks-content");
const userTaskSearch = document.getElementById("user-task-search");
const userTaskStatusFilter = document.getElementById("user-task-status-filter");
const userTaskModal = document.getElementById("user-task-modal");
const userTaskModalClose = document.getElementById("user-task-modal-close");
const userTaskForm = document.getElementById("user-task-form");
const userTaskCancel = document.getElementById("user-task-cancel");
const userTaskReviewModal = document.getElementById("user-task-review-modal");
const userTaskReviewClose = document.getElementById("user-task-review-close");
const reviewCancel = document.getElementById("review-cancel");
const reviewSubmit = document.getElementById("review-submit");

// Tab switching with ARIA support
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabName = btn.dataset.tab;

    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));

    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const tabContent = document.getElementById(`tab-${tabName}`);
    tabContent.classList.add("active");
    tabContent.setAttribute("aria-hidden", "false");

    // Update other tabs
    document.querySelectorAll(".tab-content").forEach((c) => {
      if (c !== tabContent) {
        c.setAttribute("aria-hidden", "true");
      }
    });

    if (tabName === "logs") {
      // Start log stream if not already active
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startLogStream();
      }
      // Render logs if we have buffered content
      if (logBuffer.length > 0) {
        renderLogs();
      }
      // Also check if we should load latest log file
      loadLatestLogFile();
    }

    if (tabName === "user-tasks") {
      // Load user tasks when tab is activated
      loadUserTasks();
    }

    return undefined;
  });
});

// Load latest log file content
async function loadLatestLogFile() {
  try {
    const res = await fetch(`${API_BASE}/logs/latest`);
    const data = await res.json();

    if (data.filename && logSelect.value === "live") {
      // Update log selector to show latest file
      const option = Array.from(logSelect.options).find(
        (opt) => opt.value === data.filename,
      );
      if (!option) {
        // Add it if not in list
        const newOption = document.createElement("option");
        newOption.value = data.filename;
        newOption.textContent = data.filename;
        logSelect.insertBefore(newOption, logSelect.options[1]);
      }
    }
  } catch (err) {
    // Silently fail - not critical
  }
}

// Agent control
btnStart.addEventListener("click", async () => {
  const singleMode = document.getElementById("single-mode").checked;
  const autoCommit = document.getElementById("auto-commit").checked;
  const maxLoops = parseInt(document.getElementById("max-loops").value) || 0;

  try {
    const res = await fetch(`${API_BASE}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        single: singleMode,
        autoCommit,
        maxLoops,
      }),
    });

    const data = await res.json();
    if (res.ok) {
      updateStatus(true, data.pid);
      startLogStream();
      loadStats();
      showToast("Agent started successfully", "success");
    } else {
      if (data.externalPid) {
        const msg = `${data.error}\n\nWould you like to stop the external agent and start a new one?`;
        if (confirm(msg)) {
          // Stop external agent first
          try {
            const stopRes = await fetch(`${API_BASE}/agent/stop`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ externalPid: data.externalPid }),
            });
            if (stopRes.ok) {
              // Retry start
              btnStart.click();
            } else {
              alert("Failed to stop external agent");
            }
          } catch (err) {
            alert(`Failed to stop external agent: ${err.message}`);
          }
        }
      } else {
        alert(`Error: ${data.error}`);
      }
    }
  } catch (err) {
    alert(`Failed to start agent: ${err.message}`);
  }
});

btnStop.addEventListener("click", async () => {
  try {
    const body = currentExternalPid ? { externalPid: currentExternalPid } : {};
    const res = await fetch(`${API_BASE}/agent/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (res.ok) {
      updateStatus(false);
      stopLogStream();
      currentExternalPid = null;
      showToast("Agent stopped successfully", "success");
    } else {
      showToast(`Error: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Failed to stop agent: ${err.message}`, "error");
  }
});

// Refresh buttons
btnRefreshRoadmap.addEventListener("click", loadRoadmap);
btnRefreshPrompt.addEventListener("click", loadPrompt);
btnRefreshTasks.addEventListener("click", loadTasks);
btnClearLogs.addEventListener("click", () => {
  logsContent.innerHTML = "";
  logBuffer = [];
});

// Toast notification
function showToast(message, type = "info", duration = 3000) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove("show");
  }, duration);
}

// Load functions
async function loadRoadmap() {
  try {
    roadmapContent.innerHTML = '<div class="loading"></div> Loading...';
    const res = await fetch(`${API_BASE}/roadmap`);
    const data = await res.json();

    if (typeof marked !== "undefined") {
      roadmapContent.innerHTML = marked.parse(data.content);
      // Highlight code blocks
      roadmapContent.querySelectorAll("pre code").forEach((block) => {
        if (typeof hljs !== "undefined") {
          hljs.highlightElement(block);
        }
      });
    } else {
      roadmapContent.textContent = data.content;
    }
  } catch (err) {
    roadmapContent.innerHTML = `<div style="color: #f85149;">Error loading ROADMAP.md: ${err.message}</div>`;
    showToast(`Failed to load roadmap: ${err.message}`, "error");
  }
}

async function loadPrompt() {
  try {
    promptContent.innerHTML = '<div class="loading"></div> Loading...';
    const res = await fetch(`${API_BASE}/prompt`);
    const data = await res.json();

    if (typeof marked !== "undefined") {
      promptContent.innerHTML = marked.parse(data.content);
      // Highlight code blocks
      promptContent.querySelectorAll("pre code").forEach((block) => {
        if (typeof hljs !== "undefined") {
          hljs.highlightElement(block);
        }
      });
    } else {
      promptContent.textContent = data.content;
    }
  } catch (err) {
    promptContent.innerHTML = `<div style="color: #f85149;">Error loading ROADMAP_PROMPT.md: ${err.message}</div>`;
    showToast(`Failed to load prompt: ${err.message}`, "error");
  }
}

async function loadTasks() {
  try {
    tasksContent.innerHTML = '<div class="loading"></div> Loading...';
    const res = await fetch(`${API_BASE}/tasks`);
    const data = await res.json();

    allTasks = data.tasks;
    renderTasks();
  } catch (err) {
    tasksContent.innerHTML = `<div style="color: #f85149;">Error loading tasks: ${err.message}</div>`;
    showToast(`Failed to load tasks: ${err.message}`, "error");
  }
}

function filterTasks() {
  const searchTerm = (taskSearch.value || "").toLowerCase();
  const statusFilter = taskStatusFilter.value;
  const priorityFilter = taskPriorityFilter.value;

  filteredTasks = allTasks.filter((task) => {
    const matchesSearch =
      !searchTerm ||
      task.id.toLowerCase().includes(searchTerm) ||
      task.title.toLowerCase().includes(searchTerm) ||
      task.content.toLowerCase().includes(searchTerm);

    const matchesStatus = !statusFilter || task.status === statusFilter;
    const matchesPriority = !priorityFilter || task.priority === priorityFilter;

    return matchesSearch && matchesStatus && matchesPriority;
  });

  renderTasks();
}

function renderTasks() {
  const tasksToRender = filteredTasks.length > 0 ? filteredTasks : allTasks;

  if (tasksToRender.length === 0) {
    tasksContent.innerHTML =
      '<div style="color: #8b949e; text-align: center; padding: 40px;">No tasks match the current filters.</div>';
    return;
  }

  tasksContent.innerHTML = tasksToRender
    .map(
      (task) => `
    <div class="task-item" data-task-id="${task.id}">
      <div class="task-header">
        <span class="task-id">${task.id}</span>
        <span class="task-status ${task.status}">${task.status}</span>
      </div>
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-meta">
        <span class="task-priority">Priority: ${task.priority}</span>
        ${task.dependencies.length > 0 ? `<span>Dependencies: ${task.dependencies.join(", ")}</span>` : ""}
      </div>
    </div>
  `,
    )
    .join("");

  // Add click handlers for task details
  document.querySelectorAll(".task-item").forEach((item) => {
    item.addEventListener("click", () => {
      const taskId = item.dataset.taskId;
      const task = allTasks.find((t) => t.id === taskId);
      if (task) {
        showTaskModal(task);
      }
    });
  });
}

function showTaskModal(task) {
  modalTaskId.textContent = `${task.id} - ${task.title}`;

  if (typeof marked !== "undefined") {
    modalTaskContent.innerHTML = marked.parse(task.content);
    // Highlight code blocks
    modalTaskContent.querySelectorAll("pre code").forEach((block) => {
      if (typeof hljs !== "undefined") {
        hljs.highlightElement(block);
      }
    });
  } else {
    modalTaskContent.textContent = task.content;
  }

  taskModal.classList.add("active");
}

// Task filtering event listeners
taskSearch.addEventListener("input", debounce(filterTasks, 300));
taskStatusFilter.addEventListener("change", filterTasks);
taskPriorityFilter.addEventListener("change", filterTasks);

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();

    document.getElementById("stat-total").textContent = data.stats.total;
    document.getElementById("stat-done").textContent = data.stats.done;
    document.getElementById("stat-progress").textContent =
      data.stats.inProgress;
    document.getElementById("stat-pending").textContent = data.stats.pending;
    document.getElementById("stat-blocked").textContent = data.stats.blocked;

    const progress =
      data.stats.total > 0 ? (data.stats.done / data.stats.total) * 100 : 0;
    document.getElementById("progress-fill").style.width = `${progress}%`;

    updateStatus(
      data.running,
      data.pid,
      data.isExternal,
      data.externalAgents,
      data.allAgents,
      data.subAgents,
    );

    // If external agent detected and logs tab is active, ensure streaming
    if (
      data.isExternal &&
      document.getElementById("tab-logs").classList.contains("active")
    ) {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startLogStream();
      }
    }
  } catch (err) {
    // Silently fail - will retry on next interval
  }
}

function updateStatus(
  running,
  pid = null,
  isExternal = false,
  externalAgents = [],
  allAgents = [],
  subAgents = [],
) {
  const externalInfo = document.getElementById("external-agent-info");
  const externalPidDisplay = document.getElementById("external-pid");

  if (running) {
    if (isExternal) {
      statusBadge.textContent = "Running (External)";
      statusBadge.className = "badge badge-running";
      pidDisplay.textContent = "";
      externalInfo.style.display = "flex";
      currentExternalPid = pid;

      if (externalAgents && externalAgents.length > 0) {
        const mainAgents = externalAgents.filter((a) => !a.isSubProcess);
        const subProcs = externalAgents.filter((a) => a.isSubProcess);
        let agentText = mainAgents.map((a) => `PID: ${a.pid}`).join(", ");
        if (subProcs.length > 0) {
          agentText += ` (${subProcs.length} sub-process${subProcs.length > 1 ? "es" : ""})`;
        }
        externalPidDisplay.textContent = agentText;
      } else {
        externalPidDisplay.textContent = pid ? `PID: ${pid}` : "";
      }

      btnStart.disabled = true;
      btnStop.disabled = false;
    } else {
      statusBadge.textContent = "Running";
      statusBadge.className = "badge badge-running";
      let pidText = pid ? `PID: ${pid}` : "";
      if (subAgents && subAgents.length > 0) {
        pidText += ` (${subAgents.length} sub-process${subAgents.length > 1 ? "es" : ""})`;
      }
      pidDisplay.textContent = pidText;
      externalInfo.style.display = "none";
      currentExternalPid = null;
      btnStart.disabled = true;
      btnStop.disabled = false;
    }
  } else {
    statusBadge.textContent = "Stopped";
    statusBadge.className = "badge badge-stopped";
    pidDisplay.textContent = "";
    externalInfo.style.display = "none";
    currentExternalPid = null;
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
}

function startLogStream() {
  if (eventSource) {
    eventSource.close();
  }

  const indicator = document.getElementById("log-source-indicator");
  indicator.textContent = "Connecting...";

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener("log", (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "file") {
      // Log file content - append directly
      let fileInfo = "";
      if (data.filename) {
        // Extract task ID from filename if present
        const taskMatch = data.filename.match(/task-([0-9]+\.[0-9]+)-/);
        if (taskMatch) {
          fileInfo = ` (${data.filename} - Task ${taskMatch[1]})`;
        } else {
          fileInfo = ` (${data.filename})`;
        }
      }
      indicator.textContent = `Watching log file${fileInfo}`;
      indicator.className = "log-source-indicator active";
      appendLog("stdout", data.data);
    } else if (data.type === "info") {
      // System info messages
      appendLog("info", data.data);
    } else {
      // Process stdout/stderr
      indicator.textContent = "Live process output";
      indicator.className = "log-source-indicator active";
      appendLog(data.type, data.data);
    }
  });

  eventSource.addEventListener("start", (e) => {
    const data = JSON.parse(e.data);
    appendLog("info", `Agent started (PID: ${data.pid})\n`);
    updateStatus(true, data.pid, false);
    indicator.textContent = "Live process output";
  });

  eventSource.addEventListener("exit", (e) => {
    const data = JSON.parse(e.data);
    appendLog("info", `Agent exited with code ${data.code}\n`);
    indicator.textContent = "";
    indicator.className = "log-source-indicator";
    // Check for external agents after exit
    setTimeout(loadStats, 500);
    stopLogStream();
  });

  eventSource.addEventListener("status", (e) => {
    const data = JSON.parse(e.data);
    updateStatus(
      data.running,
      data.pid,
      data.isExternal,
      data.externalAgents,
      data.allAgents,
      data.subAgents,
    );

    if (data.isExternal) {
      const subCount = data.subAgents ? data.subAgents.length : 0;
      indicator.textContent = `Watching external agent logs${subCount > 0 ? ` (${subCount} sub-process${subCount > 1 ? "es" : ""})` : ""}`;
      indicator.className = "log-source-indicator active";
    } else if (data.running) {
      const subCount = data.subAgents ? data.subAgents.length : 0;
      indicator.textContent = `Live process output${subCount > 0 ? ` (${subCount} sub-process${subCount > 1 ? "es" : ""})` : ""}`;
      indicator.className = "log-source-indicator active";
    } else {
      indicator.className = "log-source-indicator";
    }

    // If external agent detected, ensure log stream is active
    if (
      data.isExternal &&
      (!eventSource || eventSource.readyState === EventSource.CLOSED)
    ) {
      startLogStream();
    }
  });

  const maxReconnectAttempts = 10;

  eventSource.onerror = (err) => {
    // Only handle errors if connection is actually closed
    if (eventSource.readyState === EventSource.CLOSED) {
      indicator.textContent = "Connection lost";

      // Clear any pending reconnection
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Prevent infinite reconnection loops
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 10000); // Exponential backoff, max 10s
        appendLog(
          "error",
          `Connection lost. Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts}/${maxReconnectAttempts})\n`,
        );

        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
            startLogStream();
          }
        }, delay);
      } else {
        appendLog(
          "error",
          "Max reconnection attempts reached. Please refresh the page.\n",
        );
        indicator.textContent = "Connection failed - refresh page";
        indicator.className = "log-source-indicator error";
      }
    }
  };

  // Reset reconnect attempts on successful connection
  eventSource.addEventListener("open", () => {
    reconnectAttempts = 0;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  });

  // Handle ping events for connection health
  eventSource.addEventListener("ping", () => {
    // Connection is healthy, reset reconnect attempts
    reconnectAttempts = 0;
  });
}

function stopLogStream() {
  // Clear any pending reconnection
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  reconnectAttempts = 0;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const indicator = document.getElementById("log-source-indicator");
  indicator.textContent = "";
  indicator.className = "log-source-indicator";
}

// Enhanced log level detection
function detectLogLevel(line) {
  const lineLower = line.toLowerCase();

  // Error patterns
  if (
    /\b(error|exception|fatal|fail|failed|✗|❌|critical)\b/i.test(line) ||
    /error:\s/i.test(line) ||
    /exception:\s/i.test(line) ||
    /fatal error/i.test(line)
  ) {
    return "error";
  }

  // Warning patterns
  if (
    /\b(warn|warning|⚠|⚠️|deprecated|deprecation)\b/i.test(line) ||
    /warning:\s/i.test(line)
  ) {
    return "warn";
  }

  // Success patterns
  if (
    /\b(success|successful|✓|✅|completed|done|finished)\b/i.test(line) ||
    /successfully/i.test(line)
  ) {
    return "success";
  }

  // Info patterns
  if (
    /\b(info|information|→|ℹ|ℹ️|notice)\b/i.test(line) ||
    /info:\s/i.test(line) ||
    /→\s/.test(line)
  ) {
    return "info";
  }

  // Debug patterns
  if (/\b(debug|trace|verbose|🔍)\b/i.test(line) || /debug:\s/i.test(line)) {
    return "info"; // Map debug to info for now
  }

  return "stdout";
}

// Extract task IDs from log line
function extractTaskIdsFromLine(line) {
  const taskIds = [];
  // Match patterns like: task-1.2, task_1.2, Task 1.2, etc.
  const patterns = [
    /task[_-]?([0-9]+\.[0-9]+)/gi,
    /Task\s+([0-9]+\.[0-9]+)/gi,
    /\[([0-9]+\.[0-9]+)\]/g,
    /#([0-9]+\.[0-9]+)/g,
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(line)) !== null) {
      taskIds.push(match[1]);
    }
  });

  return taskIds;
}

function appendLog(type, text) {
  if (!text) return;

  const lines = text.split("\n");
  lines.forEach((line) => {
    if (line.trim() || line === "") {
      // Detect log level if not explicitly set
      const detectedType =
        type === "stdout" || type === "stderr" ? detectLogLevel(line) : type;

      // Extract task IDs
      const taskIds = extractTaskIdsFromLine(line);
      taskIds.forEach((id) => {
        detectedTaskIds.add(id);
      });

      // Always add to buffer, filtering happens during render
      logBuffer.push({
        type: detectedType,
        line,
        timestamp: new Date(),
        originalType: type,
        taskIds: taskIds.length > 0 ? taskIds : undefined,
      });

      // Update stats
      logStats.totalLines++;
      if (detectedType === "error") logStats.errorCount++;
      else if (detectedType === "warn") logStats.warnCount++;
      else if (detectedType === "info") logStats.infoCount++;
      else if (detectedType === "success") logStats.successCount++;
      else if (type === "stdout") logStats.stdoutCount++;
      else if (type === "stderr") logStats.stderrCount++;
    }
  });

  // Keep last 5000 lines (increased for better history)
  if (logBuffer.length > 5000) {
    const removedCount = logBuffer.length - 5000;
    // Remove bookmarks for removed lines
    for (let i = 0; i < removedCount; i++) {
      logBookmarks.delete(i);
    }
    // Shift remaining bookmark indices
    const newBookmarks = new Set();
    logBookmarks.forEach((idx) => {
      if (idx >= removedCount) {
        newBookmarks.add(idx - removedCount);
      }
    });
    logBookmarks = newBookmarks;
    saveBookmarks();

    logBuffer = logBuffer.slice(-5000);
    // Recalculate stats
    recalculateStats();
  }

  // Render logs efficiently (only update if visible)
  if (document.getElementById("tab-logs").classList.contains("active")) {
    renderLogs();

    // Auto-scroll if follow mode is enabled
    if (followMode) {
      setTimeout(() => {
        logsContent.scrollTop = 0; // Top because we reverse the order
      }, 10);
    }
  }
}

function recalculateStats() {
  logStats = {
    totalLines: logBuffer.length,
    errorCount: 0,
    warnCount: 0,
    infoCount: 0,
    successCount: 0,
    stdoutCount: 0,
    stderrCount: 0,
  };

  logBuffer.forEach((log) => {
    if (log.type === "error") logStats.errorCount++;
    else if (log.type === "warn") logStats.warnCount++;
    else if (log.type === "info") logStats.infoCount++;
    else if (log.type === "success") logStats.successCount++;
    else if (log.originalType === "stdout") logStats.stdoutCount++;
    else if (log.originalType === "stderr") logStats.stderrCount++;
  });
}

function filterLogs() {
  logSearchTerm = logSearch.value || "";
  renderLogs();
}

// Virtual scrolling implementation
function calculateVisibleRange() {
  if (!virtualScrollEnabled || logBuffer.length < 100) {
    return { start: 0, end: logBuffer.length };
  }

  containerHeight = logsContent.clientHeight || 500;
  const scrollTop = logsContent.scrollTop || 0;
  const linesPerViewport = Math.ceil(containerHeight / lineHeight);
  const bufferLines = Math.ceil(linesPerViewport * 0.5); // Render 50% extra above/below

  const filteredLogs = getFilteredLogs();
  const totalLines = filteredLogs.length;

  const startLine = Math.max(
    0,
    Math.floor(scrollTop / lineHeight) - bufferLines,
  );
  const endLine = Math.min(
    totalLines,
    startLine + linesPerViewport + bufferLines * 2,
  );

  return { start: startLine, end: endLine, total: totalLines };
}

function renderLogs() {
  const filteredLogs = getFilteredLogs();

  // Reverse order so latest messages appear at the top
  const reversedLogs = [...filteredLogs].reverse();

  // Enable virtual scrolling for large datasets
  virtualScrollEnabled = reversedLogs.length > 100;

  // Track search matches for navigation
  searchMatches = [];

  // Calculate visible range for virtual scrolling
  const visibleRange = calculateVisibleRange();
  const logsToRender = virtualScrollEnabled
    ? reversedLogs.slice(visibleRange.start, visibleRange.end)
    : reversedLogs;

  const fragment = document.createDocumentFragment();
  const container = document.createElement("div");

  // Add spacer for virtual scrolling
  if (virtualScrollEnabled && visibleRange.start > 0) {
    const spacer = document.createElement("div");
    spacer.style.height = `${visibleRange.start * lineHeight}px`;
    spacer.setAttribute("aria-hidden", "true");
    container.appendChild(spacer);
  }

  logsToRender.forEach((log, localIndex) => {
    const globalIndex = virtualScrollEnabled
      ? visibleRange.start + localIndex
      : localIndex;
    const bufferIndex = logBuffer.indexOf(log);
    const time = log.timestamp.toLocaleTimeString();
    const div = document.createElement("div");
    div.className = `log-line ${log.type}`;
    div.dataset.lineIndex = bufferIndex;
    div.dataset.globalIndex = globalIndex;
    div.setAttribute("role", "log");
    div.setAttribute(
      "aria-label",
      `Log line ${globalIndex + 1}, ${log.type} level`,
    );

    // Check if bookmarked
    if (logBookmarks.has(bufferIndex)) {
      div.classList.add("bookmarked");
    }

    let lineText = log.line;

    // Highlight task IDs
    if (log.taskIds && log.taskIds.length > 0) {
      log.taskIds.forEach((taskId) => {
        const taskIdPattern = new RegExp(
          `(${taskId.replace(/\./g, "\\.")})`,
          "g",
        );
        lineText = lineText.replace(
          taskIdPattern,
          '<span class="task-id-link" data-task-id="$1" role="button" tabindex="0" aria-label="Filter logs for task $1">$1</span>',
        );
      });
    }

    // Highlight URLs
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    lineText = lineText.replace(
      urlPattern,
      '<a href="$1" target="_blank" rel="noopener noreferrer" class="log-url">$1</a>',
    );

    // Highlight file paths
    const filePathPattern = /([\/~][^\s]*\.[a-zA-Z]{2,4})/g;
    lineText = lineText.replace(
      filePathPattern,
      '<span class="log-filepath">$1</span>',
    );

    // Highlight search term if present
    if (logSearchTerm && logSearchTerm.length > 0) {
      try {
        if (logSearchRegex) {
          const flags = logSearchCaseSensitive ? "g" : "gi";
          const regex = new RegExp(`(${logSearchTerm})`, flags);
          if (regex.test(log.line)) {
            // Escape HTML first, then apply highlighting
            lineText = escapeHtml(lineText).replace(regex, "<mark>$1</mark>");
            searchMatches.push(globalIndex);
          } else {
            lineText = escapeHtml(lineText);
          }
        } else {
          const escaped = escapeRegex(logSearchTerm);
          const flags = logSearchCaseSensitive ? "g" : "gi";
          const regex = new RegExp(`(${escaped})`, flags);
          if (regex.test(log.line)) {
            lineText = escapeHtml(lineText).replace(regex, "<mark>$1</mark>");
            searchMatches.push(globalIndex);
          } else {
            lineText = escapeHtml(lineText);
          }
        }
      } catch (err) {
        // Invalid regex, use simple search
        const searchLower = logSearchCaseSensitive
          ? logSearchTerm
          : logSearchTerm.toLowerCase();
        const lineLower = logSearchCaseSensitive
          ? log.line
          : log.line.toLowerCase();
        if (lineLower.includes(searchLower)) {
          const escaped = escapeRegex(logSearchTerm);
          const flags = logSearchCaseSensitive ? "g" : "gi";
          const regex = new RegExp(`(${escaped})`, flags);
          lineText = escapeHtml(lineText).replace(regex, "<mark>$1</mark>");
          searchMatches.push(globalIndex);
        } else {
          lineText = escapeHtml(lineText);
        }
      }
    } else {
      lineText = escapeHtml(lineText);
    }

    div.innerHTML = `[${time}] ${lineText}`;
    container.appendChild(div);
  });

  // Add bottom spacer for virtual scrolling
  if (virtualScrollEnabled && visibleRange.end < visibleRange.total) {
    const remainingLines = visibleRange.total - visibleRange.end;
    const spacer = document.createElement("div");
    spacer.style.height = `${remainingLines * lineHeight}px`;
    spacer.setAttribute("aria-hidden", "true");
    container.appendChild(spacer);
  }

  // Update container height for virtual scrolling
  if (virtualScrollEnabled) {
    container.style.minHeight = `${visibleRange.total * lineHeight}px`;
  }

  logsContent.innerHTML = "";
  logsContent.appendChild(container);

  // Add click handlers for task ID links
  container.querySelectorAll(".task-id-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const taskId = link.dataset.taskId;
      filterByTaskId(taskId);
    });
    link.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const taskId = link.dataset.taskId;
        filterByTaskId(taskId);
      }
    });
  });

  // Highlight current search match
  if (searchMatchIndex >= 0 && searchMatches.length > 0) {
    const matchIndex = searchMatchIndex % searchMatches.length;
    const actualIndex = searchMatches[matchIndex];
    const matchElement = logsContent.querySelector(
      `[data-global-index="${actualIndex}"]`,
    );
    if (matchElement) {
      matchElement.scrollIntoView({ behavior: "smooth", block: "center" });
      matchElement.classList.add("selected");
      setTimeout(() => matchElement.classList.remove("selected"), 2000);
    }
  }

  // Auto-scroll based on follow mode
  if (followMode) {
    // Scroll to bottom (newest logs)
    logsContent.scrollTop = 0;
  } else {
    // Auto-scroll to top only if user is near top
    const isNearTop = logsContent.scrollTop < 100;
    if (isNearTop && !virtualScrollEnabled) {
      logsContent.scrollTop = 0;
    }
  }

  // Update ARIA live region for screen readers
  updateAriaLiveRegion(filteredLogs.length);
}

function filterByTaskId(taskId) {
  // Add task ID to search filter
  if (logSearch.value && !logSearch.value.includes(taskId)) {
    logSearch.value = `${logSearch.value} ${taskId}`;
  } else {
    logSearch.value = taskId;
  }
  logSearchTerm = logSearch.value;
  filterLogs();
  renderLogs();
  showToast(`Filtered logs for task ${taskId}`, "info");
}

function updateAriaLiveRegion(lineCount) {
  let liveRegion = document.getElementById("log-aria-live");
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.id = "log-aria-live";
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    liveRegion.className = "sr-only";
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = `Displaying ${lineCount} log lines`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Export logs functionality with multiple formats
function exportLogs(format = "txt") {
  const filteredLogs = getFilteredLogs();
  const reversedLogs = [...filteredLogs].reverse();
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");

  let content, mimeType, extension, filename;

  switch (format) {
    case "json": {
      const jsonData = {
        exportedAt: new Date().toISOString(),
        totalLines: reversedLogs.length,
        stats: logStats,
        logs: reversedLogs.map((log) => ({
          timestamp: log.timestamp.toISOString(),
          type: log.type,
          level: log.type,
          line: log.line,
          taskIds: log.taskIds || [],
          bookmarked: logBookmarks.has(logBuffer.indexOf(log)),
        })),
      };
      content = JSON.stringify(jsonData, null, 2);
      mimeType = "application/json";
      filename = `roadmap-logs-${timestamp}.json`;
      break;
    }

    case "csv": {
      const csvHeaders = [
        "Timestamp",
        "Type",
        "Level",
        "Line",
        "Task IDs",
        "Bookmarked",
      ];
      const csvRows = reversedLogs.map((log) => {
        const taskIds = (log.taskIds || []).join("; ");
        const bookmarked = logBookmarks.has(logBuffer.indexOf(log))
          ? "Yes"
          : "No";
        return [
          log.timestamp.toISOString(),
          log.type,
          log.type,
          `"${log.line.replace(/"/g, '""')}"`,
          taskIds,
          bookmarked,
        ].join(",");
      });
      content = [csvHeaders.join(","), ...csvRows].join("\n");
      mimeType = "text/csv";
      filename = `roadmap-logs-${timestamp}.csv`;
      break;
    }

    case "html": {
      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Roadmap Logs Export</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
    .log-line { margin: 2px 0; padding: 4px; }
    .log-line.error { color: #f85149; }
    .log-line.warn { color: #d29922; }
    .log-line.info { color: #58a6ff; }
    .log-line.success { color: #238636; }
    .log-line.stdout { color: #c9d1d9; }
    .log-line.stderr { color: #f85149; }
    .timestamp { color: #6e7681; }
    mark { background: #d29922; color: #0d1117; }
    .task-id-link { color: #58a6ff; cursor: pointer; }
    .log-url { color: #58a6ff; }
    .log-filepath { color: #79c0ff; }
  </style>
</head>
<body>
  <h1>Roadmap Logs Export</h1>
  <p>Exported: ${new Date().toLocaleString()}</p>
  <p>Total Lines: ${reversedLogs.length}</p>
  <div class="logs">
${reversedLogs
  .map((log) => {
    const time = log.timestamp.toLocaleTimeString();
    const bookmark = logBookmarks.has(logBuffer.indexOf(log)) ? "🔖 " : "";
    const escapedLine = escapeHtml(log.line);
    return `    <div class="log-line ${log.type}">${bookmark}<span class="timestamp">[${time}]</span> ${escapedLine}</div>`;
  })
  .join("\n")}
  </div>
</body>
</html>`;
      content = htmlContent;
      mimeType = "text/html";
      filename = `roadmap-logs-${timestamp}.html`;
      break;
    }

    case "markdown": {
      const mdContent = `# Roadmap Logs Export

**Exported:** ${new Date().toLocaleString()}  
**Total Lines:** ${reversedLogs.length}

## Logs

\`\`\`
${reversedLogs
  .map((log) => {
    const time = log.timestamp.toLocaleTimeString();
    const bookmark = logBookmarks.has(logBuffer.indexOf(log)) ? "🔖 " : "";
    return `${bookmark}[${time}] ${log.line}`;
  })
  .join("\n")}
\`\`\`
`;
      content = mdContent;
      mimeType = "text/markdown";
      filename = `roadmap-logs-${timestamp}.md`;
      break;
    }

    case "txt":
    default: {
      const logText = reversedLogs
        .map((log) => {
          const time = log.timestamp.toLocaleTimeString();
          const bookmark = logBookmarks.has(logBuffer.indexOf(log))
            ? "🔖 "
            : "";
          return `${bookmark}[${time}] ${log.line}`;
        })
        .join("\n");
      content = logText;
      mimeType = "text/plain";
      filename = `roadmap-logs-${timestamp}.txt`;
      break;
    }
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Logs exported as ${format.toUpperCase()}`, "success");
}

// Export button with format selector
btnExportLogs.addEventListener("click", () => {
  // Show format selection menu
  const menu = document.createElement("div");
  menu.className = "export-menu";
  menu.innerHTML = `
    <button class="export-option" data-format="txt">Plain Text (.txt)</button>
    <button class="export-option" data-format="json">JSON (.json)</button>
    <button class="export-option" data-format="csv">CSV (.csv)</button>
    <button class="export-option" data-format="html">HTML (.html)</button>
    <button class="export-option" data-format="markdown">Markdown (.md)</button>
  `;

  // Position menu near button
  const rect = btnExportLogs.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 5}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.zIndex = "1000";

  document.body.appendChild(menu);

  // Handle clicks
  menu.querySelectorAll(".export-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const format = btn.dataset.format;
      exportLogs(format);
      document.body.removeChild(menu);
    });
  });

  // Close on outside click
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!menu.contains(e.target) && e.target !== btnExportLogs) {
        document.body.removeChild(menu);
        document.removeEventListener("click", closeHandler);
      }
    };
    document.addEventListener("click", closeHandler);
  }, 0);
});

// Load bookmarks from localStorage
function loadBookmarks() {
  try {
    const saved = localStorage.getItem("logBookmarks");
    if (saved) {
      logBookmarks = new Set(JSON.parse(saved));
    }
  } catch (err) {
    console.warn("Failed to load bookmarks:", err);
  }
}

// Save bookmarks to localStorage
function saveBookmarks() {
  try {
    localStorage.setItem(
      "logBookmarks",
      JSON.stringify(Array.from(logBookmarks)),
    );
  } catch (err) {
    console.warn("Failed to save bookmarks:", err);
  }
}

// Load font size preference
function loadFontSize() {
  try {
    const saved = localStorage.getItem("logFontSize");
    if (saved) {
      logFontSizeEl.value = saved;
      logsContentEl.style.fontSize = saved + "px";
    }
  } catch (err) {
    console.warn("Failed to load font size:", err);
  }
}

// Follow mode toggle
btnFollowMode.addEventListener("click", () => {
  followMode = !followMode;
  btnFollowMode.textContent = followMode ? "Follow ✓" : "Follow";
  btnFollowMode.classList.toggle("btn-follow-active", followMode);

  if (followMode) {
    // Scroll to bottom
    logsContentEl.scrollTop = logsContentEl.scrollHeight;
  }
});

// Font size control
logFontSizeEl.addEventListener("change", () => {
  const size = logFontSizeEl.value;
  logsContentEl.style.fontSize = size + "px";
  try {
    localStorage.setItem("logFontSize", size);
  } catch (err) {
    console.warn("Failed to save font size:", err);
  }
});

// Copy to clipboard
btnCopyLogs.addEventListener("click", () => {
  const selection = window.getSelection();
  const selectedText = selection.toString();

  if (selectedText) {
    // Copy selected text
    navigator.clipboard
      .writeText(selectedText)
      .then(() => {
        showToast("Copied to clipboard", "success");
      })
      .catch((err) => {
        // Fallback for older browsers
        const textarea = document.createElement("textarea");
        textarea.value = selectedText;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
          showToast("Copied to clipboard", "success");
        } catch (err) {
          showToast("Failed to copy", "error");
        }
        document.body.removeChild(textarea);
      });
  } else {
    // Copy all visible filtered logs
    const filteredLogs = getFilteredLogs();
    const logText = filteredLogs
      .map((log) => {
        const time = log.timestamp.toLocaleTimeString();
        return `[${time}] ${log.line}`;
      })
      .join("\n");

    navigator.clipboard
      .writeText(logText)
      .then(() => {
        showToast("Copied all logs to clipboard", "success");
      })
      .catch((err) => {
        showToast("Failed to copy", "error");
      });
  }
});

// Enhanced search with regex and case sensitivity
logSearchRegexEl.addEventListener("change", () => {
  logSearchRegex = logSearchRegexEl.checked;
  filterLogs();
  renderLogs();
});

logSearchCaseEl.addEventListener("change", () => {
  logSearchCaseSensitive = logSearchCaseEl.checked;
  filterLogs();
  renderLogs();
});

// Virtual scrolling: handle scroll events
logsContent.addEventListener(
  "scroll",
  debounce(() => {
    if (virtualScrollEnabled) {
      renderLogs();
    }
  }, 50),
);

// Handle window resize for virtual scrolling
window.addEventListener(
  "resize",
  debounce(() => {
    if (virtualScrollEnabled) {
      renderLogs();
    }
  }, 200),
);

// Log filtering event listeners
logSearch.addEventListener(
  "input",
  debounce(() => {
    filterLogs();
    renderLogs();
  }, 300),
);

logLevelFilterEl.addEventListener("change", () => {
  filterLogs();
  renderLogs();
});

// Bookmark toggle on log line double-click
logsContentEl.addEventListener("dblclick", (e) => {
  const logLine = e.target.closest(".log-line");
  if (!logLine) return;

  const lineIndex = parseInt(logLine.dataset.lineIndex);
  if (Number.isNaN(lineIndex)) return;

  if (logBookmarks.has(lineIndex)) {
    logBookmarks.delete(lineIndex);
    logLine.classList.remove("bookmarked");
    showToast("Bookmark removed", "info");
  } else {
    logBookmarks.add(lineIndex);
    logLine.classList.add("bookmarked");
    showToast("Bookmark added", "success");
  }
  saveBookmarks();
});

// Get filtered logs helper
function getFilteredLogs() {
  const currentLogLevelFilter = logLevelFilterEl.value;
  let filtered = logBuffer;

  if (logSearchTerm || currentLogLevelFilter) {
    filtered = logBuffer.filter((log) => {
      let matchesSearch = true;

      if (logSearchTerm) {
        if (logSearchRegex) {
          try {
            const flags = logSearchCaseSensitive ? "g" : "gi";
            const regex = new RegExp(logSearchTerm, flags);
            matchesSearch = regex.test(log.line);
          } catch (err) {
            // Invalid regex, fall back to simple search
            matchesSearch = logSearchCaseSensitive
              ? log.line.includes(logSearchTerm)
              : log.line.toLowerCase().includes(logSearchTerm.toLowerCase());
          }
        } else {
          matchesSearch = logSearchCaseSensitive
            ? log.line.includes(logSearchTerm)
            : log.line.toLowerCase().includes(logSearchTerm.toLowerCase());
        }
      }

      const matchesLevel =
        !currentLogLevelFilter || log.type === currentLogLevelFilter;
      return matchesSearch && matchesLevel;
    });
  }

  return filtered;
}

// Modal close handlers
modalClose.addEventListener("click", () => {
  taskModal.classList.remove("active");
});

taskModal.addEventListener("click", (e) => {
  if (e.target === taskModal) {
    taskModal.classList.remove("active");
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const activeTab = document.querySelector(".tab-btn.active");
  const isLogsTab = activeTab && activeTab.dataset.tab === "logs";
  const isTasksTab = activeTab && activeTab.dataset.tab === "tasks";

  // ESC to close modal
  if (e.key === "Escape") {
    if (taskModal.classList.contains("active")) {
      taskModal.classList.remove("active");
      e.preventDefault();
    } else if (userTaskModal.classList.contains("active")) {
      userTaskModal.classList.remove("active");
      e.preventDefault();
    } else if (userTaskReviewModal.classList.contains("active")) {
      userTaskReviewModal.classList.remove("active");
      e.preventDefault();
    }
  }

  // Don't trigger shortcuts when typing in inputs
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    // Allow some shortcuts even in inputs
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === "g" || e.key === "G" || e.key === "f" || e.key === "F")
    ) {
      // Allow search shortcuts
    } else if (e.key === "f" && isLogsTab) {
      // Allow 'f' for follow mode
    } else {
      return;
    }
  }

  // Ctrl/Cmd + F: Focus search
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    if (isLogsTab) {
      e.preventDefault();
      logSearch.focus();
      logSearch.select();
    } else if (isTasksTab) {
      e.preventDefault();
      taskSearch.focus();
      taskSearch.select();
    }
  }

  // Ctrl/Cmd + G: Next match (logs tab only)
  if ((e.ctrlKey || e.metaKey) && e.key === "g" && isLogsTab && !e.shiftKey) {
    e.preventDefault();
    if (searchMatches.length > 0) {
      searchMatchIndex = (searchMatchIndex + 1) % searchMatches.length;
      renderLogs();
    }
  }

  // Ctrl/Cmd + Shift + G: Previous match (logs tab only)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "G" && isLogsTab) {
    e.preventDefault();
    if (searchMatches.length > 0) {
      searchMatchIndex =
        searchMatchIndex <= 0 ? searchMatches.length - 1 : searchMatchIndex - 1;
      renderLogs();
    }
  }

  // Ctrl/Cmd + K: Focus search (alternative)
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    if (isTasksTab) {
      e.preventDefault();
      taskSearch.focus();
    } else if (isLogsTab) {
      e.preventDefault();
      logSearch.focus();
    }
  }

  // Ctrl/Cmd + E: Export logs (logs tab only)
  if ((e.ctrlKey || e.metaKey) && e.key === "e" && isLogsTab) {
    e.preventDefault();
    btnExportLogs.click();
  }

  // F: Toggle follow mode (logs tab only)
  if (
    e.key === "f" &&
    isLogsTab &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey
  ) {
    e.preventDefault();
    btnFollowMode.click();
  }

  // Ctrl/Cmd + K: Clear logs (when in logs tab and search is focused)
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "k" &&
    isLogsTab &&
    document.activeElement === logSearch
  ) {
    // Already handled above
  }
});

// Load log files list with enhanced metadata
async function loadLogFiles() {
  try {
    const res = await fetch(`${API_BASE}/logs`);
    const data = await res.json();

    logSelect.innerHTML = '<option value="live">Live Stream</option>';
    data.logs.forEach((log) => {
      const option = document.createElement("option");
      option.value = log;
      const metadata = data.metadata && data.metadata[log];
      if (metadata) {
        let label = log;
        const parts = [];

        // Add active indicator
        if (metadata.isCurrentlyActive) {
          parts.push("⚡ LIVE");
        } else if (metadata.isActive) {
          parts.push("⚡");
        }

        // Add task ID if available
        if (metadata.taskId) {
          parts.push(`Task ${metadata.taskId}`);
        }

        // Add process association if available
        if (metadata.associatedPid) {
          parts.push(`PID ${metadata.associatedPid}`);
        }

        // Add age
        parts.push(metadata.formattedAge);

        if (parts.length > 0) {
          label = `${log} (${parts.join(" • ")})`;
        } else {
          label = `${log} (${metadata.formattedAge})`;
        }

        option.textContent = label;

        // Mark currently active files
        if (metadata.isCurrentlyActive) {
          option.style.fontWeight = "bold";
          option.style.color = "#238636";
        } else if (metadata.isActive) {
          option.style.color = "#58a6ff";
        }
      } else {
        option.textContent = log;
      }
      logSelect.appendChild(option);
    });
  } catch (err) {
    // Silently fail - will retry on next interval
  }
}

logSelect.addEventListener("change", async (e) => {
  const filename = e.target.value;
  const indicator = document.getElementById("log-source-indicator");

  if (filename === "live") {
    // Clear current logs and start streaming
    logsContent.innerHTML = "";
    logBuffer = [];
    startLogStream();
  } else {
    // Stop streaming and load specific file
    stopLogStream();

    // Clear buffer when switching to a specific file
    logBuffer = [];
    logsContent.innerHTML = "";

    try {
      const res = await fetch(`${API_BASE}/logs/${filename}`);
      const data = await res.json();

      // Build indicator text with metadata
      let indicatorText = `Viewing: ${filename}`;
      if (data.metadata) {
        const parts = [];
        if (data.metadata.taskId) {
          parts.push(`Task ${data.metadata.taskId}`);
        }
        if (data.metadata.associatedProcess) {
          parts.push(`PID ${data.metadata.associatedProcess.pid}`);
        }
        parts.push(
          data.metadata.size > 0 ? formatFileSize(data.metadata.size) : "empty",
        );
        if (parts.length > 0) {
          indicatorText += ` (${parts.join(" • ")})`;
        }
      }
      indicator.textContent = indicatorText;

      // Format log content with line-by-line display
      const lines = data.content.split("\n");
      const fragment = document.createDocumentFragment();
      const container = document.createElement("div");

      // Clear buffer and rebuild from file
      logBuffer = [];
      lines.forEach((line, idx) => {
        if (line.trim() || line === "") {
          // Try to detect log level from line content
          const lineLower = line.toLowerCase();
          let type = "stdout";
          if (
            lineLower.includes("error") ||
            lineLower.includes("✗") ||
            lineLower.includes("failed")
          ) {
            type = "error";
          } else if (lineLower.includes("warn") || lineLower.includes("!")) {
            type = "warn";
          } else if (
            lineLower.includes("success") ||
            lineLower.includes("✓") ||
            lineLower.includes("completed")
          ) {
            type = "success";
          } else if (lineLower.includes("info") || lineLower.includes("→")) {
            type = "info";
          }

          logBuffer.push({ type, line, timestamp: new Date() });
        }
      });

      // Render using the standard render function
      renderLogs();
    } catch (err) {
      logsContent.innerHTML = `<div class="log-line error">Error loading log: ${err.message}</div>`;
      indicator.textContent = "";
    }
  }
});

function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

// Load log statistics
async function loadLogStatistics() {
  try {
    const res = await fetch(`${API_BASE}/logs/stats`);
    if (res.ok) {
      const data = await res.json();
      updateStatisticsDisplay(data);
    }
  } catch (err) {
    // Silently fail - stats are optional
  }
}

// Toggle statistics panel
btnLogStats.addEventListener("click", () => {
  const isVisible = logStatsPanel.style.display !== "none";
  logStatsPanel.style.display = isVisible ? "none" : "block";
  btnLogStats.textContent = isVisible ? "Stats" : "Hide Stats";
  btnLogStats.setAttribute("aria-expanded", (!isVisible).toString());

  if (!isVisible) {
    loadLogStatistics();
  }
});

// Load and display cross-worker timeline
async function loadWorkerTimeline() {
  try {
    const res = await fetch(`${API_BASE}/logs/timeline`);
    if (!res.ok) {
      throw new Error("Failed to load timeline");
    }

    const data = await res.json();
    displayWorkerTimeline(data);
  } catch (err) {
    showToast(`Failed to load timeline: ${err.message}`, "error");
  }
}

function displayWorkerTimeline(data) {
  // Create or update timeline panel
  let timelinePanel = document.getElementById("worker-timeline-panel");
  if (!timelinePanel) {
    timelinePanel = document.createElement("div");
    timelinePanel.id = "worker-timeline-panel";
    timelinePanel.className = "worker-timeline";
    timelinePanel.setAttribute("role", "region");
    timelinePanel.setAttribute("aria-label", "Cross-worker timeline");
    logsContent.parentNode.insertBefore(timelinePanel, logsContent);
  }

  // Display merged timeline
  const mergedLogs = data.merged || [];

  timelinePanel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
      <h3 style="margin: 0; color: #58a6ff;">Cross-Worker Timeline</h3>
      <button id="close-timeline" class="btn btn-sm" aria-label="Close timeline">Close</button>
    </div>
    <div style="margin-bottom: 10px; color: #8b949e; font-size: 12px;">
      ${data.totalWorkers} workers, ${data.totalLogs} total logs
    </div>
    <div>
      ${mergedLogs
        .slice(0, 100)
        .map(
          (log) => `
        <div class="worker-timeline-item ${log.level}">
          <div class="worker-timeline-header">
            <span>${log.workerId}</span>
            <span style="font-size: 11px; color: #6e7681;">${log.timestamp || "N/A"}</span>
          </div>
          <div style="color: #c9d1d9; font-size: 12px;">${escapeHtml(log.content)}</div>
        </div>
      `,
        )
        .join("")}
      ${mergedLogs.length > 100 ? `<div style="text-align: center; color: #8b949e; padding: 10px;">Showing first 100 of ${mergedLogs.length} logs</div>` : ""}
    </div>
  `;

  // Add close handler
  document.getElementById("close-timeline").addEventListener("click", () => {
    timelinePanel.style.display = "none";
    btnWorkerTimeline.textContent = "Timeline";
  });

  timelinePanel.style.display = "block";
  btnWorkerTimeline.textContent = "Hide Timeline";
}

btnWorkerTimeline.addEventListener("click", () => {
  const timelinePanel = document.getElementById("worker-timeline-panel");
  const isVisible = timelinePanel && timelinePanel.style.display !== "none";

  if (isVisible) {
    timelinePanel.style.display = "none";
    btnWorkerTimeline.textContent = "Timeline";
  } else {
    loadWorkerTimeline();
  }
});

function updateStatisticsDisplay(stats) {
  // Update stats in UI if stats panel exists
  const statsPanel = document.getElementById("log-stats-panel");
  if (statsPanel) {
    statsPanel.innerHTML = `
      <div class="stat-item">
        <span class="stat-label">Total Lines:</span>
        <span class="stat-value">${stats.totalLines || logStats.totalLines}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Errors:</span>
        <span class="stat-value error">${stats.errorCount || logStats.errorCount}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Warnings:</span>
        <span class="stat-value warn">${stats.warnCount || logStats.warnCount}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Info:</span>
        <span class="stat-value info">${stats.infoCount || logStats.infoCount}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Success:</span>
        <span class="stat-value success">${stats.successCount || logStats.successCount}</span>
      </div>
      ${
        stats.errorRate !== undefined
          ? `
      <div class="stat-item">
        <span class="stat-label">Error Rate:</span>
        <span class="stat-value">${(stats.errorRate * 100).toFixed(2)}%</span>
      </div>
      `
          : ""
      }
      ${
        stats.linesPerSecond !== undefined
          ? `
      <div class="stat-item">
        <span class="stat-label">Lines/sec:</span>
        <span class="stat-value">${stats.linesPerSecond.toFixed(1)}</span>
      </div>
      `
          : ""
      }
    `;
  }
}

// Initial load
loadRoadmap();
loadPrompt();
loadTasks();
loadStats();
loadLogFiles();
loadUserTasks();
loadBookmarks();
loadFontSize();
loadLogStatistics();

// Refresh statistics periodically
setInterval(loadLogStatistics, 5000);

// Initialize filters
filteredTasks = allTasks;

// Auto-refresh stats every 5 seconds (includes external agent detection)
setInterval(loadStats, 5000);

// Refresh log files list periodically (more frequently when logs tab is active)
let logFilesInterval = setInterval(loadLogFiles, 10000);

// Increase refresh rate when logs tab is active
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabName = btn.dataset.tab;
    if (tabName === "logs") {
      // Refresh more frequently when logs tab is active
      clearInterval(logFilesInterval);
      logFilesInterval = setInterval(loadLogFiles, 5000);
    } else {
      // Normal refresh rate when other tabs are active
      clearInterval(logFilesInterval);
      logFilesInterval = setInterval(loadLogFiles, 10000);
    }
  });
});

// Health check and auto-recovery
let healthCheckInterval = setInterval(async () => {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const health = await res.json();

    // If we're supposed to be watching logs but connection is closed, reconnect
    if (document.getElementById("tab-logs").classList.contains("active")) {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startLogStream();
      }
    }
  } catch (err) {
    // Silently fail - will retry on next interval
  }
}, 15000); // Every 15 seconds

// User Tasks Functions
async function loadUserTasks() {
  try {
    const res = await fetch(`${API_BASE}/user-tasks`);
    const data = await res.json();
    allUserTasks = data.tasks || [];
    filterUserTasks();
  } catch (err) {
    userTasksContent.innerHTML = `<div style="color: #f85149;">Error loading user tasks: ${err.message}</div>`;
  }
}

function filterUserTasks() {
  const searchTerm = (userTaskSearch.value || "").toLowerCase();
  const statusFilter = userTaskStatusFilter.value;

  filteredUserTasks = allUserTasks.filter((task) => {
    const matchesSearch =
      !searchTerm ||
      task.id.toLowerCase().includes(searchTerm) ||
      task.title.toLowerCase().includes(searchTerm) ||
      (task.description && task.description.toLowerCase().includes(searchTerm));

    const matchesStatus = !statusFilter || task.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  renderUserTasks();
}

function renderUserTasks() {
  const tasksToRender =
    filteredUserTasks.length > 0 ? filteredUserTasks : allUserTasks;

  if (tasksToRender.length === 0) {
    userTasksContent.innerHTML =
      '<div style="color: #8b949e; text-align: center; padding: 40px;">No user tasks found. Create one to get started!</div>';
    return;
  }

  userTasksContent.innerHTML = tasksToRender
    .map((task) => {
      const createdAt = new Date(task.createdAt).toLocaleString();
      const statusClass = task.status.toLowerCase().replace("_", "-");
      const reviewBadge = task.reviewStatus
        ? `<span class="review-badge ${task.reviewStatus}">${task.reviewStatus}</span>`
        : "";
      const agentBadge =
        task.createdBy === "agent"
          ? `<span class="agent-badge" title="Created by ${task.sourceAgent || "agent"}">🤖 Agent</span>`
          : "";

      return `
      <div class="user-task-item" data-task-id="${task.id}">
        <div class="user-task-header">
          <div>
            <span class="user-task-id">${task.id}</span>
            <span class="user-task-status ${statusClass}">${task.status}</span>
            ${agentBadge}
            ${reviewBadge}
          </div>
          <div class="user-task-actions">
            ${task.status === "PENDING" || task.status === "ASSIGNED" ? `<button class="btn-icon assign-btn" data-task-id="${task.id}" title="Assign to agent">🚀</button>` : ""}
            ${task.status === "COMPLETED" && !task.reviewStatus ? `<button class="btn-icon review-btn" data-task-id="${task.id}" title="Review">✓</button>` : ""}
            ${task.status !== "IN_PROGRESS" ? `<button class="btn-icon edit-btn" data-task-id="${task.id}" title="Edit">✏️</button>` : ""}
            <button class="btn-icon delete-btn" data-task-id="${task.id}" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="user-task-title">${escapeHtml(task.title)}</div>
        ${task.description ? `<div class="user-task-description">${escapeHtml(task.description)}</div>` : ""}
        <div class="user-task-meta">
          <span class="user-task-priority">Priority: ${task.priority}</span>
          <span>Created: ${createdAt}</span>
          ${task.assignedAt ? `<span>Assigned: ${new Date(task.assignedAt).toLocaleString()}</span>` : ""}
          ${task.completedAt ? `<span>Completed: ${new Date(task.completedAt).toLocaleString()}</span>` : ""}
        </div>
        ${task.reviewNotes ? `<div class="user-task-review-notes"><strong>Review:</strong> ${escapeHtml(task.reviewNotes)}</div>` : ""}
      </div>
    `;
    })
    .join("");

  // Add event listeners
  document.querySelectorAll(".assign-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      assignUserTask(btn.dataset.taskId);
    });
  });

  document.querySelectorAll(".review-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showReviewModal(btn.dataset.taskId);
    });
  });

  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editUserTask(btn.dataset.taskId);
    });
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteUserTask(btn.dataset.taskId);
    });
  });
}

async function assignUserTask(taskId) {
  if (!confirm("Assign this task to an agent?")) return;

  try {
    const res = await fetch(`${API_BASE}/user-tasks/${taskId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const data = await res.json();
    if (res.ok) {
      showToast("Task assigned to agent", "success");
      loadUserTasks();
    } else {
      showToast(`Error: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Failed to assign task: ${err.message}`, "error");
  }
}

async function deleteUserTask(taskId) {
  if (!confirm("Delete this task? This cannot be undone.")) return;

  try {
    const res = await fetch(`${API_BASE}/user-tasks/${taskId}`, {
      method: "DELETE",
    });

    const data = await res.json();
    if (res.ok) {
      showToast("Task deleted", "success");
      loadUserTasks();
    } else {
      showToast(`Error: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Failed to delete task: ${err.message}`, "error");
  }
}

function showCreateUserTaskModal() {
  document.getElementById("user-task-modal-title").textContent =
    "Create User Task";
  userTaskForm.reset();
  userTaskForm.dataset.taskId = "";
  userTaskModal.classList.add("active");
}

function editUserTask(taskId) {
  const task = allUserTasks.find((t) => t.id === taskId);
  if (!task) return;

  document.getElementById("user-task-modal-title").textContent =
    "Edit User Task";
  document.getElementById("user-task-title").value = task.title;
  document.getElementById("user-task-description").value =
    task.description || "";
  document.getElementById("user-task-priority").value = task.priority;
  document.getElementById("user-task-assign").checked = false;
  userTaskForm.dataset.taskId = taskId;
  userTaskModal.classList.add("active");
}

function showReviewModal(taskId) {
  const task = allUserTasks.find((t) => t.id === taskId);
  if (!task) return;

  currentReviewTaskId = taskId;
  document.getElementById("review-task-info").innerHTML = `
    <div class="review-task-header">
      <h3>${escapeHtml(task.title)}</h3>
      <p><strong>ID:</strong> ${task.id}</p>
      ${task.description ? `<p><strong>Description:</strong> ${escapeHtml(task.description)}</p>` : ""}
    </div>
  `;
  document.getElementById("review-status").value =
    task.reviewStatus || "approved";
  document.getElementById("review-notes").value = task.reviewNotes || "";
  userTaskReviewModal.classList.add("active");
}

async function submitReview() {
  if (!currentReviewTaskId) return;

  const status = document.getElementById("review-status").value;
  const notes = document.getElementById("review-notes").value;

  try {
    const res = await fetch(
      `${API_BASE}/user-tasks/${currentReviewTaskId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes }),
      },
    );

    const data = await res.json();
    if (res.ok) {
      showToast("Review submitted", "success");
      userTaskReviewModal.classList.remove("active");
      currentReviewTaskId = null;
      loadUserTasks();
    } else {
      showToast(`Error: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Failed to submit review: ${err.message}`, "error");
  }
}

// Event listeners for user tasks
btnCreateUserTask.addEventListener("click", showCreateUserTaskModal);
btnRefreshUserTasks.addEventListener("click", loadUserTasks);
userTaskSearch.addEventListener("input", debounce(filterUserTasks, 300));
userTaskStatusFilter.addEventListener("change", filterUserTasks);

userTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("user-task-title").value;
  const description = document.getElementById("user-task-description").value;
  const priority = document.getElementById("user-task-priority").value;
  const assignToAgent = document.getElementById("user-task-assign").checked;
  const taskId = userTaskForm.dataset.taskId;

  try {
    let res;
    if (taskId) {
      // Update existing task
      res = await fetch(`${API_BASE}/user-tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, priority, assignToAgent }),
      });
    } else {
      // Create new task
      res = await fetch(`${API_BASE}/user-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, priority, assignToAgent }),
      });
    }

    const data = await res.json();
    if (res.ok) {
      showToast(taskId ? "Task updated" : "Task created", "success");
      userTaskModal.classList.remove("active");
      loadUserTasks();

      // If assigned, offer to start agent
      if (assignToAgent && !taskId) {
        if (confirm("Task created and assigned. Start agent now?")) {
          btnStart.click();
        }
      }
    } else {
      showToast(`Error: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Failed to save task: ${err.message}`, "error");
  }
});

userTaskCancel.addEventListener("click", () => {
  userTaskModal.classList.remove("active");
});

userTaskModalClose.addEventListener("click", () => {
  userTaskModal.classList.remove("active");
});

userTaskModal.addEventListener("click", (e) => {
  if (e.target === userTaskModal) {
    userTaskModal.classList.remove("active");
  }
});

reviewCancel.addEventListener("click", () => {
  userTaskReviewModal.classList.remove("active");
  currentReviewTaskId = null;
});

userTaskReviewClose.addEventListener("click", () => {
  userTaskReviewModal.classList.remove("active");
  currentReviewTaskId = null;
});

reviewSubmit.addEventListener("click", submitReview);

userTaskReviewModal.addEventListener("click", (e) => {
  if (e.target === userTaskReviewModal) {
    userTaskReviewModal.classList.remove("active");
    currentReviewTaskId = null;
  }
});
