const API_BASE = 'http://localhost:3001/api';

let eventSource = null;
let logBuffer = [];
let currentExternalPid = null;
let allTasks = [];
let filteredTasks = [];
let logSearchTerm = '';
let logLevelFilter = '';
let allUserTasks = [];
let filteredUserTasks = [];
let currentReviewTaskId = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;

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
const btnCreateUserTask = document.getElementById('btn-create-user-task');
const btnRefreshUserTasks = document.getElementById('btn-refresh-user-tasks');
const userTasksContent = document.getElementById('user-tasks-content');
const userTaskSearch = document.getElementById('user-task-search');
const userTaskStatusFilter = document.getElementById('user-task-status-filter');
const userTaskModal = document.getElementById('user-task-modal');
const userTaskModalClose = document.getElementById('user-task-modal-close');
const userTaskForm = document.getElementById('user-task-form');
const userTaskCancel = document.getElementById('user-task-cancel');
const userTaskReviewModal = document.getElementById('user-task-review-modal');
const userTaskReviewClose = document.getElementById('user-task-review-close');
const reviewCancel = document.getElementById('review-cancel');
const reviewSubmit = document.getElementById('review-submit');

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
    
    if (tabName === 'user-tasks') {
      // Load user tasks when tab is activated
      loadUserTasks();
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
    // Silently fail - not critical
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
    
  } catch (err) {
    // Silently fail - will retry on next interval
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
      let fileInfo = '';
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
      indicator.className = 'log-source-indicator active';
      appendLog('stdout', data.data);
    } else if (data.type === 'info') {
      // System info messages
      appendLog('info', data.data);
    } else {
      // Process stdout/stderr
      indicator.textContent = 'Live process output';
      indicator.className = 'log-source-indicator active';
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
    indicator.className = 'log-source-indicator';
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
      indicator.className = 'log-source-indicator active';
    } else if (data.running) {
      const subCount = data.subAgents ? data.subAgents.length : 0;
      indicator.textContent = `Live process output${subCount > 0 ? ` (${subCount} sub-process${subCount > 1 ? 'es' : ''})` : ''}`;
      indicator.className = 'log-source-indicator active';
    } else {
      indicator.className = 'log-source-indicator';
    }
    
    // If external agent detected, ensure log stream is active
    if (data.isExternal && (!eventSource || eventSource.readyState === EventSource.CLOSED)) {
      startLogStream();
    }
  });
  
  const maxReconnectAttempts = 10;
  
  eventSource.onerror = (err) => {
    // Only handle errors if connection is actually closed
    if (eventSource.readyState === EventSource.CLOSED) {
      indicator.textContent = 'Connection lost';
      
      // Clear any pending reconnection
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      
      // Prevent infinite reconnection loops
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 10000); // Exponential backoff, max 10s
        appendLog('error', `Connection lost. Reconnecting in ${delay/1000}s... (attempt ${reconnectAttempts}/${maxReconnectAttempts})\n`);
        
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
            startLogStream();
          }
        }, delay);
      } else {
        appendLog('error', 'Max reconnection attempts reached. Please refresh the page.\n');
        indicator.textContent = 'Connection failed - refresh page';
        indicator.className = 'log-source-indicator error';
      }
    }
  };
  
  // Reset reconnect attempts on successful connection
  eventSource.addEventListener('open', () => {
    reconnectAttempts = 0;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  });
  
  // Handle ping events for connection health
  eventSource.addEventListener('ping', () => {
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
  const indicator = document.getElementById('log-source-indicator');
  indicator.textContent = '';
  indicator.className = 'log-source-indicator';
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
  
  // Reverse order so latest messages appear at the top
  const reversedLogs = [...filteredLogs].reverse();
  
  reversedLogs.forEach(log => {
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
  
  // Auto-scroll to top only if user is near top
  const isNearTop = logsContent.scrollTop < 100;
  if (isNearTop) {
    logsContent.scrollTop = 0;
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
  
  // Reverse order for export so latest messages appear first
  const reversedLogs = [...filteredLogs].reverse();
  const logText = reversedLogs.map(log => {
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

// Load log files list with enhanced metadata
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
        let label = log;
        const parts = [];
        
        // Add active indicator
        if (metadata.isCurrentlyActive) {
          parts.push('⚡ LIVE');
        } else if (metadata.isActive) {
          parts.push('⚡');
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
          label = `${log} (${parts.join(' • ')})`;
        } else {
          label = `${log} (${metadata.formattedAge})`;
        }
        
        option.textContent = label;
        
        // Mark currently active files
        if (metadata.isCurrentlyActive) {
          option.style.fontWeight = 'bold';
          option.style.color = '#238636';
        } else if (metadata.isActive) {
          option.style.color = '#58a6ff';
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
    
    // Clear buffer when switching to a specific file
    logBuffer = [];
    logsContent.innerHTML = '';
    
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
        parts.push(data.metadata.size > 0 ? formatFileSize(data.metadata.size) : 'empty');
        if (parts.length > 0) {
          indicatorText += ` (${parts.join(' • ')})`;
        }
      }
      indicator.textContent = indicatorText;
      
      // Format log content with line-by-line display
      const lines = data.content.split('\n');
      const fragment = document.createDocumentFragment();
      const container = document.createElement('div');
      
      // Reverse order so latest messages appear at the top
      const reversedLines = [...lines].reverse();
      
      reversedLines.forEach((line, index) => {
        const div = document.createElement('div');
        div.className = 'log-line stdout';
        
        // Try to detect log level from line content
        const lineLower = line.toLowerCase();
        if (lineLower.includes('error') || lineLower.includes('✗') || lineLower.includes('failed')) {
          div.className = 'log-line error';
        } else if (lineLower.includes('warn') || lineLower.includes('!')) {
          div.className = 'log-line warn';
        } else if (lineLower.includes('success') || lineLower.includes('✓') || lineLower.includes('completed')) {
          div.className = 'log-line success';
        } else if (lineLower.includes('info') || lineLower.includes('→')) {
          div.className = 'log-line info';
        }
        
        // Escape HTML but preserve structure
        div.textContent = line;
        container.appendChild(div);
      });
      
      fragment.appendChild(container);
      logsContent.innerHTML = '';
      logsContent.appendChild(fragment);
      
      // Scroll to top
      logsContent.scrollTop = 0;
    } catch (err) {
      logsContent.innerHTML = `<div class="log-line error">Error loading log: ${err.message}</div>`;
      indicator.textContent = '';
    }
  }
});

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Initial load
loadRoadmap();
loadPrompt();
loadTasks();
loadStats();
loadLogFiles();
loadUserTasks();

// Initialize filters
filteredTasks = allTasks;

// Auto-refresh stats every 5 seconds (includes external agent detection)
setInterval(loadStats, 5000);

// Refresh log files list periodically (more frequently when logs tab is active)
let logFilesInterval = setInterval(loadLogFiles, 10000);

// Increase refresh rate when logs tab is active
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    if (tabName === 'logs') {
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
    if (document.getElementById('tab-logs').classList.contains('active')) {
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
  const searchTerm = (userTaskSearch.value || '').toLowerCase();
  const statusFilter = userTaskStatusFilter.value;
  
  filteredUserTasks = allUserTasks.filter(task => {
    const matchesSearch = !searchTerm || 
      task.id.toLowerCase().includes(searchTerm) ||
      task.title.toLowerCase().includes(searchTerm) ||
      (task.description && task.description.toLowerCase().includes(searchTerm));
    
    const matchesStatus = !statusFilter || task.status === statusFilter;
    
    return matchesSearch && matchesStatus;
  });
  
  renderUserTasks();
}

function renderUserTasks() {
  const tasksToRender = filteredUserTasks.length > 0 ? filteredUserTasks : allUserTasks;
  
  if (tasksToRender.length === 0) {
    userTasksContent.innerHTML = '<div style="color: #8b949e; text-align: center; padding: 40px;">No user tasks found. Create one to get started!</div>';
    return;
  }
  
  userTasksContent.innerHTML = tasksToRender.map(task => {
    const createdAt = new Date(task.createdAt).toLocaleString();
    const statusClass = task.status.toLowerCase().replace('_', '-');
    const reviewBadge = task.reviewStatus ? `<span class="review-badge ${task.reviewStatus}">${task.reviewStatus}</span>` : '';
    const agentBadge = task.createdBy === 'agent' ? `<span class="agent-badge" title="Created by ${task.sourceAgent || 'agent'}">🤖 Agent</span>` : '';
    
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
            ${task.status === 'PENDING' || task.status === 'ASSIGNED' ? `<button class="btn-icon assign-btn" data-task-id="${task.id}" title="Assign to agent">🚀</button>` : ''}
            ${task.status === 'COMPLETED' && !task.reviewStatus ? `<button class="btn-icon review-btn" data-task-id="${task.id}" title="Review">✓</button>` : ''}
            ${task.status !== 'IN_PROGRESS' ? `<button class="btn-icon edit-btn" data-task-id="${task.id}" title="Edit">✏️</button>` : ''}
            <button class="btn-icon delete-btn" data-task-id="${task.id}" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="user-task-title">${escapeHtml(task.title)}</div>
        ${task.description ? `<div class="user-task-description">${escapeHtml(task.description)}</div>` : ''}
        <div class="user-task-meta">
          <span class="user-task-priority">Priority: ${task.priority}</span>
          <span>Created: ${createdAt}</span>
          ${task.assignedAt ? `<span>Assigned: ${new Date(task.assignedAt).toLocaleString()}</span>` : ''}
          ${task.completedAt ? `<span>Completed: ${new Date(task.completedAt).toLocaleString()}</span>` : ''}
        </div>
        ${task.reviewNotes ? `<div class="user-task-review-notes"><strong>Review:</strong> ${escapeHtml(task.reviewNotes)}</div>` : ''}
      </div>
    `;
  }).join('');
  
  // Add event listeners
  document.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      assignUserTask(btn.dataset.taskId);
    });
  });
  
  document.querySelectorAll('.review-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showReviewModal(btn.dataset.taskId);
    });
  });
  
  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editUserTask(btn.dataset.taskId);
    });
  });
  
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteUserTask(btn.dataset.taskId);
    });
  });
}

async function assignUserTask(taskId) {
  if (!confirm('Assign this task to an agent?')) return;
  
  try {
    const res = await fetch(`${API_BASE}/user-tasks/${taskId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast('Task assigned to agent', 'success');
      loadUserTasks();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to assign task: ${err.message}`, 'error');
  }
}

async function deleteUserTask(taskId) {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  
  try {
    const res = await fetch(`${API_BASE}/user-tasks/${taskId}`, {
      method: 'DELETE'
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast('Task deleted', 'success');
      loadUserTasks();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to delete task: ${err.message}`, 'error');
  }
}

function showCreateUserTaskModal() {
  document.getElementById('user-task-modal-title').textContent = 'Create User Task';
  userTaskForm.reset();
  userTaskForm.dataset.taskId = '';
  userTaskModal.classList.add('active');
}

function editUserTask(taskId) {
  const task = allUserTasks.find(t => t.id === taskId);
  if (!task) return;
  
  document.getElementById('user-task-modal-title').textContent = 'Edit User Task';
  document.getElementById('user-task-title').value = task.title;
  document.getElementById('user-task-description').value = task.description || '';
  document.getElementById('user-task-priority').value = task.priority;
  document.getElementById('user-task-assign').checked = false;
  userTaskForm.dataset.taskId = taskId;
  userTaskModal.classList.add('active');
}

function showReviewModal(taskId) {
  const task = allUserTasks.find(t => t.id === taskId);
  if (!task) return;
  
  currentReviewTaskId = taskId;
  document.getElementById('review-task-info').innerHTML = `
    <div class="review-task-header">
      <h3>${escapeHtml(task.title)}</h3>
      <p><strong>ID:</strong> ${task.id}</p>
      ${task.description ? `<p><strong>Description:</strong> ${escapeHtml(task.description)}</p>` : ''}
    </div>
  `;
  document.getElementById('review-status').value = task.reviewStatus || 'approved';
  document.getElementById('review-notes').value = task.reviewNotes || '';
  userTaskReviewModal.classList.add('active');
}

async function submitReview() {
  if (!currentReviewTaskId) return;
  
  const status = document.getElementById('review-status').value;
  const notes = document.getElementById('review-notes').value;
  
  try {
    const res = await fetch(`${API_BASE}/user-tasks/${currentReviewTaskId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes })
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast('Review submitted', 'success');
      userTaskReviewModal.classList.remove('active');
      currentReviewTaskId = null;
      loadUserTasks();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to submit review: ${err.message}`, 'error');
  }
}

// Event listeners for user tasks
btnCreateUserTask.addEventListener('click', showCreateUserTaskModal);
btnRefreshUserTasks.addEventListener('click', loadUserTasks);
userTaskSearch.addEventListener('input', debounce(filterUserTasks, 300));
userTaskStatusFilter.addEventListener('change', filterUserTasks);

userTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const title = document.getElementById('user-task-title').value;
  const description = document.getElementById('user-task-description').value;
  const priority = document.getElementById('user-task-priority').value;
  const assignToAgent = document.getElementById('user-task-assign').checked;
  const taskId = userTaskForm.dataset.taskId;
  
  try {
    let res;
    if (taskId) {
      // Update existing task
      res = await fetch(`${API_BASE}/user-tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, priority, assignToAgent })
      });
    } else {
      // Create new task
      res = await fetch(`${API_BASE}/user-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, priority, assignToAgent })
      });
    }
    
    const data = await res.json();
    if (res.ok) {
      showToast(taskId ? 'Task updated' : 'Task created', 'success');
      userTaskModal.classList.remove('active');
      loadUserTasks();
      
      // If assigned, offer to start agent
      if (assignToAgent && !taskId) {
        if (confirm('Task created and assigned. Start agent now?')) {
          btnStart.click();
        }
      }
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to save task: ${err.message}`, 'error');
  }
});

userTaskCancel.addEventListener('click', () => {
  userTaskModal.classList.remove('active');
});

userTaskModalClose.addEventListener('click', () => {
  userTaskModal.classList.remove('active');
});

userTaskModal.addEventListener('click', (e) => {
  if (e.target === userTaskModal) {
    userTaskModal.classList.remove('active');
  }
});

reviewCancel.addEventListener('click', () => {
  userTaskReviewModal.classList.remove('active');
  currentReviewTaskId = null;
});

userTaskReviewClose.addEventListener('click', () => {
  userTaskReviewModal.classList.remove('active');
  currentReviewTaskId = null;
});

reviewSubmit.addEventListener('click', submitReview);

userTaskReviewModal.addEventListener('click', (e) => {
  if (e.target === userTaskReviewModal) {
    userTaskReviewModal.classList.remove('active');
    currentReviewTaskId = null;
  }
});
