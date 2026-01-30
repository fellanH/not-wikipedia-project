const API_BASE = 'http://localhost:3001/api';

let eventSource = null;
let logBuffer = [];
let currentExternalPid = null;

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
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to stop agent: ${err.message}`);
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

// Load functions
async function loadRoadmap() {
  try {
    const res = await fetch(`${API_BASE}/roadmap`);
    const data = await res.json();
    roadmapContent.textContent = data.content;
  } catch (err) {
    roadmapContent.textContent = `Error loading ROADMAP.md: ${err.message}`;
  }
}

async function loadPrompt() {
  try {
    const res = await fetch(`${API_BASE}/prompt`);
    const data = await res.json();
    promptContent.textContent = data.content;
  } catch (err) {
    promptContent.textContent = `Error loading ROADMAP_PROMPT.md: ${err.message}`;
  }
}

async function loadTasks() {
  try {
    const res = await fetch(`${API_BASE}/tasks`);
    const data = await res.json();
    
    tasksContent.innerHTML = data.tasks.map(task => `
      <div class="task-item">
        <div class="task-header">
          <span class="task-id">${task.id}</span>
          <span class="task-status ${task.status}">${task.status}</span>
        </div>
        <div class="task-title">${task.title}</div>
        <div class="task-meta">
          <span class="task-priority">Priority: ${task.priority}</span>
          ${task.dependencies.length > 0 ? `<span>Dependencies: ${task.dependencies.join(', ')}</span>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    tasksContent.innerHTML = `<div style="color: #f85149;">Error loading tasks: ${err.message}</div>`;
  }
}

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
    
    updateStatus(data.running, data.pid, data.isExternal, data.externalAgents);
    
    // If external agent detected and logs tab is active, ensure streaming
    if (data.isExternal && document.getElementById('tab-logs').classList.contains('active')) {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startLogStream();
      }
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function updateStatus(running, pid = null, isExternal = false, externalAgents = []) {
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
        const agentList = externalAgents.map(a => `PID: ${a.pid}`).join(', ');
        externalPidDisplay.textContent = agentList;
      } else {
        externalPidDisplay.textContent = pid ? `PID: ${pid}` : '';
      }
      
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else {
      statusBadge.textContent = 'Running';
      statusBadge.className = 'badge badge-running';
      pidDisplay.textContent = pid ? `PID: ${pid}` : '';
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
      indicator.textContent = 'Watching log file';
      appendLog('stdout', data.data);
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
    updateStatus(data.running, data.pid, data.isExternal, data.externalAgents);
    
    if (data.isExternal) {
      indicator.textContent = 'Watching external agent logs';
    } else if (data.running) {
      indicator.textContent = 'Live process output';
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
  const lines = text.split('\n');
  lines.forEach(line => {
    if (line.trim()) {
      logBuffer.push({ type, line, timestamp: new Date() });
    }
  });
  
  // Keep last 1000 lines
  if (logBuffer.length > 1000) {
    logBuffer = logBuffer.slice(-1000);
  }
  
  // Render logs
  logsContent.innerHTML = logBuffer.map(log => {
    const time = log.timestamp.toLocaleTimeString();
    return `<div class="log-line ${log.type}">[${time}] ${escapeHtml(log.line)}</div>`;
  }).join('');
  
  // Auto-scroll to bottom
  logsContent.scrollTop = logsContent.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Load log files list
async function loadLogFiles() {
  try {
    const res = await fetch(`${API_BASE}/logs`);
    const data = await res.json();
    
    logSelect.innerHTML = '<option value="live">Live Stream</option>';
    data.logs.forEach(log => {
      const option = document.createElement('option');
      option.value = log;
      option.textContent = log;
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

// Auto-refresh stats every 5 seconds (includes external agent detection)
setInterval(loadStats, 5000);

// Refresh log files list periodically
setInterval(loadLogFiles, 10000);
