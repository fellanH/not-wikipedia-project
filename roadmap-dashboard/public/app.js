const API_BASE = 'http://localhost:3001/api';

let eventSource = null;
let logBuffer = [];
let currentExternalPid = null;
let allTasks = [];
let filteredTasks = [];
let logSearchTerm = '';
let logLevelFilter = '';

// Configure marked for markdown rendering
if (typeof marked !== 'undefined') {
  marked.setOptions({
    highlight: function(code, lang) {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (err) {}
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true
  });
}

// DOM elements
const statusBadge = document.getElementById('status-badge');
const pidDisplay = document.getElementById('pid-display');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnRefreshRoadmap = document.getElementById('btn-refresh-roadmap');
const btnRefreshPrompt = document.getElementById('btn-refresh-prompt');
const btnRefreshTasks = document.getElementById('btn-refresh-tasks');
const btnClearLogs = document.getElementById('btn-clear-logs');
const roadmapContent = document.getElementById('roadmap-content');
const promptContent = document.getElementById('prompt-content');
const logsContent = document.getElementById('logs-content');
const tasksContent = document.getElementById('tasks-content');
const logSelect = document.getElementById('log-select');
const taskSearch = document.getElementById('task-search');
const taskStatusFilter = document.getElementById('task-status-filter');
const taskPriorityFilter = document.getElementById('task-priority-filter');
const logSearch = document.getElementById('log-search');
const logLevelFilterEl = document.getElementById('log-level-filter');
const btnExportLogs = document.getElementById('btn-export-logs');
const taskModal = document.getElementById('task-modal');
const modalClose = document.getElementById('modal-close');
const modalTaskId = document.getElementById('modal-task-id');
const modalTaskContent = document.getElementById('modal-task-content');

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    btn.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    if (tabName === 'logs') {
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
  });
});

// Load latest log file content
async function loadLatestLogFile() {
  try {
    const res = await fetch(`${API_BASE}/logs/latest`);
    const data = await res.json();
    
    if (data.filename && logSelect.value === 'live') {
      // Update log selector to show latest file
      const option = Array.from(logSelect.options).find(opt => opt.value === data.filename);
      if (!option) {
        // Add it if not in list
        const newOption = document.createElement('option');
        newOption.value = data.filename;
        newOption.textContent = data.filename;
        logSelect.insertBefore(newOption, logSelect.options[1]);
      }
    }
  } catch (err) {
    console.error('Failed to load latest log file:', err);
  }
}

// Agent control
btnStart.addEventListener('click', async () => {
  const singleMode = document.getElementById('single-mode').checked;
  const autoCommit = document.getElementById('auto-commit').checked;
  const maxLoops = parseInt(document.getElementById('max-loops').value) || 0;
  
  try {
    const res = await fetch(`${API_BASE}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        single: singleMode,
        autoCommit,
        maxLoops
      })
    });
    
    const data = await res.json();
    if (res.ok) {
      updateStatus(true, data.pid);
      startLogStream();
      loadStats();
      showToast('Agent started successfully', 'success');
    } else {
      if (data.externalPid) {
        const msg = `${data.error}\n\nWould you like to stop the external agent and start a new one?`;
        if (confirm(msg)) {
          // Stop external agent first
          try {
            const stopRes = await fetch(`${API_BASE}/agent/stop`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ externalPid: data.externalPid })
            });
            if (stopRes.ok) {
              // Retry start
              btnStart.click();
            } else {
              alert('Failed to stop external agent');
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

btnStop.addEventListener('click', async () => {
  try {
    const body = currentExternalPid ? { externalPid: currentExternalPid } : {};
    const res = await fetch(`${API_BASE}/agent/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const data = await res.json();
    if (res.ok) {
      updateStatus(false);
      stopLogStream();
      currentExternalPid = null;
      showToast('Agent stopped successfully', 'success');
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to stop agent: ${err.message}`, 'error');
  }
});

// Refresh buttons
btnRefreshRoadmap.addEventListener('click', loadRoadmap);
btnRefreshPrompt.addEventListener('click', loadPrompt);
btnRefreshTasks.addEventListener('click', loadTasks);
btnClearLogs.addEventListener('click', () => {
  logsContent.innerHTML = '';
  logBuffer = [];
});

// Toast notification
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// Load functions
async function loadRoadmap() {
  try {
    roadmapContent.innerHTML = '<div class="loading"></div> Loading...';
    const res = await fetch(`${API_BASE}/roadmap`);
    const data = await res.json();
    
    if (typeof marked !== 'undefined') {
      roadmapContent.innerHTML = marked.parse(data.content);
      // Highlight code blocks
      roadmapContent.querySelectorAll('pre code').forEach((block) => {
        if (typeof hljs !== 'undefined') {
          hljs.highlightElement(block);
        }
      });
    } else {
      roadmapContent.textContent = data.content;
    }
  } catch (err) {
    roadmapContent.innerHTML = `<div style="color: #f85149;">Error loading ROADMAP.md: ${err.message}</div>`;
    showToast(`Failed to load roadmap: ${err.message}`, 'error');
  }
}

async function loadPrompt() {
  try {
    promptContent.innerHTML = '<div class="loading"></div> Loading...';
    const res = await fetch(`${API_BASE}/prompt`);
    const data = await res.json();
    
    if (typeof marked !== 'undefined') {
      promptContent.innerHTML = marked.parse(data.content);
      // Highlight code blocks
      promptContent.querySelectorAll('pre code').forEach((block) => {
        if (typeof hljs !== 'undefined') {
          hljs.highlightElement(block);
        }
      });
    } else {
      promptContent.textContent = data.content;
    }
  } catch (err) {
    promptContent.innerHTML = `<div style="color: #f85149;">Error loading ROADMAP_PROMPT.md: ${err.message}</div>`;
    showToast(`Failed to load prompt: ${err.message}`, 'error');
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
    showToast(`Failed to load tasks: ${err.message}`, 'error');
  }
}

function filterTasks() {
  const searchTerm = (taskSearch.value || '').toLowerCase();
  const statusFilter = taskStatusFilter.value;
  const priorityFilter = taskPriorityFilter.value;
  
  filteredTasks = allTasks.filter(task => {
    const matchesSearch = !searchTerm || 
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
    tasksContent.innerHTML = '<div style="color: #8b949e; text-align: center; padding: 40px;">No tasks match the current filters.</div>';
    return;
  }
  
  tasksContent.innerHTML = tasksToRender.map(task => `
    <div class="task-item" data-task-id="${task.id}">
      <div class="task-header">
        <span class="task-id">${task.id}</span>
        <span class="task-status ${task.status}">${task.status}</span>
      </div>
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-meta">
        <span class="task-priority">Priority: ${task.priority}</span>
        ${task.dependencies.length > 0 ? `<span>Dependencies: ${task.dependencies.join(', ')}</span>` : ''}
      </div>
    </div>
  `).join('');
  
  // Add click handlers for task details
  document.querySelectorAll('.task-item').forEach(item => {
    item.addEventListener('click', () => {
      const taskId = item.dataset.taskId;
      const task = allTasks.find(t => t.id === taskId);
      if (task) {
        showTaskModal(task);
      }
    });
  });
}

function showTaskModal(task) {
  modalTaskId.textContent = `${task.id} - ${task.title}`;
  
  if (typeof marked !== 'undefined') {
    modalTaskContent.innerHTML = marked.parse(task.content);
    // Highlight code blocks
    modalTaskContent.querySelectorAll('pre code').forEach((block) => {
      if (typeof hljs !== 'undefined') {
        hljs.highlightElement(block);
      }
    });
  } else {
    modalTaskContent.textContent = task.content;
  }
  
  taskModal.classList.add('active');
}

// Task filtering event listeners
taskSearch.addEventListener('input', debounce(filterTasks, 300));
taskStatusFilter.addEventListener('change', filterTasks);
taskPriorityFilter.addEventListener('change', filterTasks);

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    
    document.getElementById('stat-total').textContent = data.stats.total;
    document.getElementById('stat-done').textContent = data.stats.done;
    document.getElementById('stat-progress').textContent = data.stats.inProgress;
    document.getElementById('stat-pending').textContent = data.stats.pending;
    document.getElementById('stat-blocked').textContent = data.stats.blocked;
    
    const progress = data.stats.total > 0 
      ? (data.stats.done / data.stats.total) * 100 
      : 0;
    document.getElementById('progress-fill').style.width = `${progress}%`;
    
    updateStatus(data.running, data.pid, data.isExternal, data.externalAgents, data.allAgents, data.subAgents);
    
    // If external agent detected and logs tab is active, ensure streaming
    if (data.isExternal && document.getElementById('tab-logs').classList.contains('active')) {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startLogStream();
      }
    }
    
    // Log sub-process detection
    if (data.subAgents && data.subAgents.length > 0) {
      console.log(`Detected ${data.subAgents.length} sub-process(es):`, data.subAgents);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function updateStatus(running, pid = null, isExternal = false, externalAgents = [], allAgents = [], subAgents = []) {
  const externalInfo = document.getElementById('external-agent-info');
  const externalPidDisplay = document.getElementById('external-pid');
  
  if (running) {
    if (isExternal) {
      statusBadge.textContent = 'Running (External)';
      statusBadge.className = 'badge badge-running';
      pidDisplay.textContent = '';
      externalInfo.style.display = 'flex';
      currentExternalPid = pid;
      
      if (externalAgents && externalAgents.length > 0) {
        const mainAgents = externalAgents.filter(a => !a.isSubProcess);
        const subProcs = externalAgents.filter(a => a.isSubProcess);
        let agentText = mainAgents.map(a => `PID: ${a.pid}`).join(', ');
        if (subProcs.length > 0) {
          agentText += ` (${subProcs.length} sub-process${subProcs.length > 1 ? 'es' : ''})`;
        }
        externalPidDisplay.textContent = agentText;
      } else {
        externalPidDisplay.textContent = pid ? `PID: ${pid}` : '';
      }
      
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else {
      statusBadge.textContent = 'Running';
      statusBadge.className = 'badge badge-running';
      let pidText = pid ? `PID: ${pid}` : '';
      if (subAgents && subAgents.length > 0) {
        pidText += ` (${subAgents.length} sub-process${subAgents.length > 1 ? 'es' : ''})`;
      }
      pidDisplay.textContent = pidText;
      externalInfo.style.display = 'none';
      currentExternalPid = null;
      btnStart.disabled = true;
      btnStop.disabled = false;
    }
  } else {
    statusBadge.textContent = 'Stopped';
    statusBadge.className = 'badge badge-stopped';
    pidDisplay.textContent = '';
    externalInfo.style.display = 'none';
    currentExternalPid = null;
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
}

function startLogStream() {
  if (eventSource) {
    eventSource.close();
  }
  
  const indicator = document.getElementById('log-source-indicator');
  indicator.textContent = 'Connecting...';
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'file') {
      // Log file content - append directly
      const fileInfo = data.filename ? ` (${data.filename})` : '';
      indicator.textContent = `Watching log file${fileInfo}`;
      appendLog('stdout', data.data);
    } else if (data.type === 'info') {
      // System info messages
      appendLog('info', data.data);
    } else {
      // Process stdout/stderr
      indicator.textContent = 'Live process output';
      appendLog(data.type, data.data);
    }
  });
  
  eventSource.addEventListener('start', (e) => {
    const data = JSON.parse(e.data);
    appendLog('info', `Agent started (PID: ${data.pid})\n`);
    updateStatus(true, data.pid, false);
    indicator.textContent = 'Live process output';
  });
  
  eventSource.addEventListener('exit', (e) => {
    const data = JSON.parse(e.data);
    appendLog('info', `Agent exited with code ${data.code}\n`);
    indicator.textContent = '';
    // Check for external agents after exit
    setTimeout(loadStats, 500);
    stopLogStream();
  });
  
  eventSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    updateStatus(data.running, data.pid, data.isExternal, data.externalAgents, data.allAgents, data.subAgents);
    
    if (data.isExternal) {
      const subCount = data.subAgents ? data.subAgents.length : 0;
      indicator.textContent = `Watching external agent logs${subCount > 0 ? ` (${subCount} sub-process${subCount > 1 ? 'es' : ''})` : ''}`;
    } else if (data.running) {
      const subCount = data.subAgents ? data.subAgents.length : 0;
      indicator.textContent = `Live process output${subCount > 0 ? ` (${subCount} sub-process${subCount > 1 ? 'es' : ''})` : ''}`;
    }
    
    // If external agent detected, ensure log stream is active
    if (data.isExternal && (!eventSource || eventSource.readyState === EventSource.CLOSED)) {
      startLogStream();
    }
  });
  
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    indicator.textContent = 'Connection lost';
    appendLog('error', 'Connection lost. Reconnecting...\n');
    // Reconnect after a delay
    setTimeout(() => {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startLogStream();
      }
    }, 2000);
  };
}

function stopLogStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const indicator = document.getElementById('log-source-indicator');
  indicator.textContent = '';
}

function appendLog(type, text) {
  if (!text) return;
  
  const lines = text.split('\n');
  lines.forEach(line => {
    if (line.trim() || line === '') {
      // Always add to buffer, filtering happens during render
  logBuffer.push({ type, line, timestamp: new Date() });
    }
  });
  
  // Keep last 5000 lines (increased for better history)
  if (logBuffer.length > 5000) {
    logBuffer = logBuffer.slice(-5000);
  }
  
  // Render logs efficiently (only update if visible)
  if (document.getElementById('tab-logs').classList.contains('active')) {
    renderLogs();
  }
}

function filterLogs() {
  logSearchTerm = (logSearch.value || '').toLowerCase();
  logLevelFilter = logLevelFilterEl.value;
  renderLogs();
}

function renderLogs() {
  const fragment = document.createDocumentFragment();
  const container = document.createElement('div');
  
  const currentLogLevelFilter = logLevelFilterEl.value;
  let filteredLogs = logBuffer;
  
  // Apply filters
  if (logSearchTerm || currentLogLevelFilter) {
    filteredLogs = logBuffer.filter(log => {
      const matchesSearch = !logSearchTerm || log.line.toLowerCase().includes(logSearchTerm);
      const matchesLevel = !currentLogLevelFilter || log.type === currentLogLevelFilter;
      return matchesSearch && matchesLevel;
    });
  }
  
  filteredLogs.forEach(log => {
    const time = log.timestamp.toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-line ${log.type}`;
    
    let lineText = log.line;
    // Highlight search term if present
    if (logSearchTerm && logSearchTerm.length > 0) {
      const regex = new RegExp(`(${escapeRegex(logSearchTerm)})`, 'gi');
      lineText = lineText.replace(regex, '<mark>$1</mark>');
    }
    
    div.innerHTML = `[${time}] ${lineText}`;
    container.appendChild(div);
  });
  
  logsContent.innerHTML = '';
  logsContent.appendChild(container);
  
  // Auto-scroll to bottom only if user is near bottom
  const isNearBottom = logsContent.scrollHeight - logsContent.scrollTop - logsContent.clientHeight < 100;
  if (isNearBottom) {
    logsContent.scrollTop = logsContent.scrollHeight;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(text) {
  const div = document.createElement('div');
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

// Export logs functionality
btnExportLogs.addEventListener('click', () => {
  const currentLogLevelFilter = logLevelFilterEl.value;
  const filteredLogs = logSearchTerm || currentLogLevelFilter 
    ? logBuffer.filter(log => {
        const matchesSearch = !logSearchTerm || log.line.toLowerCase().includes(logSearchTerm);
        const matchesLevel = !currentLogLevelFilter || log.type === currentLogLevelFilter;
        return matchesSearch && matchesLevel;
      })
    : logBuffer;
  
  const logText = filteredLogs.map(log => {
    const time = log.timestamp.toLocaleTimeString();
    return `[${time}] ${log.line}`;
  }).join('\n');
  
  const blob = new Blob([logText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `roadmap-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast('Logs exported successfully', 'success');
});

// Log filtering event listeners
logSearch.addEventListener('input', debounce(() => {
  filterLogs();
  renderLogs();
}, 300));

logLevelFilterEl.addEventListener('change', () => {
  filterLogs();
  renderLogs();
});

// Modal close handlers
modalClose.addEventListener('click', () => {
  taskModal.classList.remove('active');
});

taskModal.addEventListener('click', (e) => {
  if (e.target === taskModal) {
    taskModal.classList.remove('active');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // ESC to close modal
  if (e.key === 'Escape' && taskModal.classList.contains('active')) {
    taskModal.classList.remove('active');
  }
  
  // Ctrl/Cmd + K to focus search (when in tasks tab)
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab && activeTab.dataset.tab === 'tasks') {
      e.preventDefault();
      taskSearch.focus();
    } else if (activeTab && activeTab.dataset.tab === 'logs') {
      e.preventDefault();
      logSearch.focus();
    }
  }
});

// Load log files list
async function loadLogFiles() {
  try {
    const res = await fetch(`${API_BASE}/logs`);
    const data = await res.json();
    
    logSelect.innerHTML = '<option value="live">Live Stream</option>';
    data.logs.forEach(log => {
      const option = document.createElement('option');
      option.value = log;
      const metadata = data.metadata && data.metadata[log];
      if (metadata) {
        const label = metadata.isActive 
          ? `${log} ⚡ ${metadata.formattedAge}`
          : `${log} (${metadata.formattedAge})`;
        option.textContent = label;
      } else {
        option.textContent = log;
      }
      logSelect.appendChild(option);
    });
  } catch (err) {
    console.error('Failed to load log files:', err);
  }
}

logSelect.addEventListener('change', async (e) => {
  const filename = e.target.value;
  const indicator = document.getElementById('log-source-indicator');
  
  if (filename === 'live') {
    // Clear current logs and start streaming
    logsContent.innerHTML = '';
    logBuffer = [];
    startLogStream();
  } else {
    // Stop streaming and load specific file
    stopLogStream();
    indicator.textContent = `Viewing: ${filename}`;
    try {
      const res = await fetch(`${API_BASE}/logs/${filename}`);
      const data = await res.json();
      logsContent.innerHTML = `<div class="log-line">${escapeHtml(data.content)}</div>`;
    } catch (err) {
      logsContent.innerHTML = `<div class="log-line error">Error loading log: ${err.message}</div>`;
      indicator.textContent = '';
    }
  }
});

// Initial load
loadRoadmap();
loadPrompt();
loadTasks();
loadStats();
loadLogFiles();

// Initialize filters
filteredTasks = allTasks;

// Auto-refresh stats every 5 seconds (includes external agent detection)
setInterval(loadStats, 5000);

// Refresh log files list periodically
setInterval(loadLogFiles, 10000);

// Health check and auto-recovery
let healthCheckInterval = setInterval(async () => {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const health = await res.json();
    
    // If we're supposed to be watching logs but connection is closed, reconnect
    if (document.getElementById('tab-logs').classList.contains('active')) {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        console.log('Log stream disconnected, reconnecting...');
        startLogStream();
      }
    }
    
    // Log health status periodically
    if (health.agents && health.agents.total > 0) {
      console.debug(`Health: ${health.agents.total} agent(s) running (${health.agents.subProcesses} sub-processes)`);
    }
  } catch (err) {
    console.error('Health check failed:', err);
  }
}, 15000); // Every 15 seconds
