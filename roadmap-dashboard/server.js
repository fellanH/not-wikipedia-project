#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const { EventEmitter } = require('events');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROADMAP_FILE = path.join(PROJECT_ROOT, 'ROADMAP.md');
const PROMPT_FILE = path.join(PROJECT_ROOT, 'ROADMAP_PROMPT.md');
const LOG_DIR = path.join(PROJECT_ROOT, 'roadmap-logs');
const AGENT_SCRIPT = path.join(PROJECT_ROOT, 'roadmap-agent.sh');

// Agent process management
let agentProcess = null;
const agentEvents = new EventEmitter();

// Get process tree (parent and all children)
async function getProcessTree(pid) {
  const processes = [];
  const visited = new Set();
  
  const addProcess = async (p) => {
    if (visited.has(p) || !p) return;
    visited.add(p);
    
    try {
      // Get process info
      const { stdout: psOut } = await execAsync(`ps -p ${p} -o pid,ppid,comm,args 2>/dev/null || ps -p ${p} -o pid=,ppid=,comm=,args= 2>/dev/null`);
      if (!psOut.trim()) return;
      
      const parts = psOut.trim().split(/\s+/);
      if (parts.length < 3) return;
      
      const procPid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const comm = parts[2] || '';
      const args = parts.slice(3).join(' ') || '';
      
      processes.push({
        pid: procPid,
        ppid,
        comm,
        args,
        cmd: `${comm} ${args}`.trim()
      });
      
      // Find children
      try {
        const { stdout: childrenOut } = await execAsync(`pgrep -P ${p} 2>/dev/null || echo ""`);
        const children = childrenOut.trim().split('\n').filter(c => c).map(c => parseInt(c));
        for (const childPid of children) {
          await addProcess(childPid);
        }
      } catch (err) {
        // No children or error finding them
      }
    } catch (err) {
      // Process doesn't exist or can't access
    }
  };
  
  await addProcess(pid);
  return processes;
}

// Find running agent processes including sub-processes
async function findRunningAgents() {
  try {
    const scriptName = path.basename(AGENT_SCRIPT);
    const allProcesses = [];
    
    // Find main agent processes
    let mainPids = [];
    try {
      const { stdout } = await execAsync(`pgrep -fl "${scriptName}"`);
      const lines = stdout.trim().split('\n')
        .filter(l => l.includes(scriptName) && !l.includes('grep') && !l.includes('pgrep'));
      
      mainPids = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return parseInt(parts[0]);
      }).filter(p => !isNaN(p));
    } catch (err) {
      if (err.code !== 1) {
        console.error('Error finding main agents:', err);
      }
    }
    
    // Also find claude processes that might be sub-agents
    try {
      const { stdout: claudeOut } = await execAsync(`pgrep -fl "claude.*roadmap|claude.*PROMPT"`);
      const claudeLines = claudeOut.trim().split('\n')
        .filter(l => l.includes('claude') && (l.includes('roadmap') || l.includes('PROMPT')) && !l.includes('grep'));
      
      const claudePids = claudeLines.map(line => {
        const parts = line.trim().split(/\s+/);
        return parseInt(parts[0]);
      }).filter(p => !isNaN(p));
      
      mainPids.push(...claudePids);
    } catch (err) {
      // No claude processes found
    }
    
    // Get full process tree for each main PID
    for (const pid of mainPids) {
      try {
        const tree = await getProcessTree(pid);
        allProcesses.push(...tree);
      } catch (err) {
        // If we can't get tree, at least add the main process
        try {
          const { stdout: psOut } = await execAsync(`ps -p ${pid} -o pid=,comm=,args= 2>/dev/null`);
          if (psOut.trim()) {
            const parts = psOut.trim().split(/\s+/);
            allProcesses.push({
              pid: parseInt(parts[0]),
              ppid: null,
              comm: parts[1] || '',
              args: parts.slice(2).join(' ') || '',
              cmd: psOut.trim()
            });
          }
        } catch (err2) {
          // Skip this process
        }
      }
    }
    
    // Deduplicate and format
    const unique = new Map();
    for (const proc of allProcesses) {
      if (!unique.has(proc.pid)) {
        unique.set(proc.pid, {
          pid: proc.pid,
          ppid: proc.ppid,
          comm: proc.comm,
          cmd: proc.cmd,
          isExternal: !agentProcess || proc.pid !== agentProcess.pid,
          isSubProcess: proc.comm === 'claude' || proc.comm.includes('claude')
        });
      }
    }
    
    return Array.from(unique.values());
  } catch (err) {
    console.error('Error finding running agents:', err);
    return [];
  }
}

// Verify process is still running
async function verifyProcess(pid) {
  try {
    await execAsync(`kill -0 ${pid} 2>/dev/null`);
    return true;
  } catch (err) {
    return false;
  }
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const allAgents = await findRunningAgents();
    const verifiedAgents = [];
    
    for (const agent of allAgents) {
      if (await verifyProcess(agent.pid)) {
        verifiedAgents.push(agent);
      }
    }
    
    const activeFiles = await getActiveLogFiles(600000);
    
    res.json({
      status: 'healthy',
      timestamp: Date.now(),
      agents: {
        total: verifiedAgents.length,
        main: verifiedAgents.filter(a => !a.isSubProcess).length,
        subProcesses: verifiedAgents.filter(a => a.isSubProcess).length
      },
      logs: {
        activeFiles: activeFiles.filter(f => f.isActive).length,
        totalFiles: activeFiles.length
      },
      watchers: logWatchers.size
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
      timestamp: Date.now()
    });
  }
});

// Get the most recent running agent PID
async function getExternalAgentPid() {
  const agents = await findRunningAgents();
  if (agents.length === 0) return null;
  
  // Verify processes are still running and filter
  const verifiedAgents = [];
  for (const agent of agents) {
    if (await verifyProcess(agent.pid)) {
      verifiedAgents.push(agent);
    }
  }
  
  if (verifiedAgents.length === 0) return null;
  
  // Return the first external agent (or any if we don't have our own)
  const external = verifiedAgents.find(a => a.isExternal);
  return external ? external.pid : verifiedAgents[0].pid;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Get agent status
app.get('/api/status', async (req, res) => {
  const isRunning = agentProcess !== null && !agentProcess.killed;
  const allAgents = await findRunningAgents();
  
  // Verify all agents are still running
  const verifiedAgents = [];
  for (const agent of allAgents) {
    if (await verifyProcess(agent.pid)) {
      verifiedAgents.push(agent);
    }
  }
  
  const externalPid = await getExternalAgentPid();
  const hasExternalAgent = externalPid !== null && (!isRunning || externalPid !== agentProcess.pid);
  
  // Parse ROADMAP.md for task counts
  let stats = {
    total: 0,
    done: 0,
    inProgress: 0,
    pending: 0,
    blocked: 0
  };

  try {
    const content = await fs.readFile(ROADMAP_FILE, 'utf-8');
    const lines = content.split('\n');
    
    // Extract header stats
    const headerMatch = content.match(/\*\*Total Tasks\*\*:\s*(\d+)/);
    if (headerMatch) stats.total = parseInt(headerMatch[1]);
    
    stats.done = (content.match(/`DONE`/g) || []).length;
    stats.inProgress = (content.match(/`IN_PROGRESS`/g) || []).length;
    stats.blocked = (content.match(/`BLOCKED`/g) || []).length;
    stats.pending = stats.total - stats.done - stats.inProgress - stats.blocked;
  } catch (err) {
    console.error('Error reading ROADMAP.md:', err);
  }

  res.json({
    running: isRunning || hasExternalAgent,
    pid: isRunning ? agentProcess.pid : (hasExternalAgent ? externalPid : null),
    isExternal: hasExternalAgent && !isRunning,
    externalAgents: verifiedAgents
      .filter(a => a.isExternal || !isRunning)
      .map(a => ({ pid: a.pid, cmd: a.cmd })),
    stats
  });
});

// Get ROADMAP.md content
app.get('/api/roadmap', async (req, res) => {
  try {
    const content = await fs.readFile(ROADMAP_FILE, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get ROADMAP_PROMPT.md content
app.get('/api/prompt', async (req, res) => {
  try {
    const content = await fs.readFile(PROMPT_FILE, 'utf-8');
    res.json({ content });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.json({ content: '# ROADMAP_PROMPT.md\n\n*File not yet generated. Run a task to generate this file.*' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Get list of log files with metadata
app.get('/api/logs', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const now = Date.now();
    const logFiles = files
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const filepath = path.join(LOG_DIR, f);
        try {
          const stats = fsSync.statSync(filepath);
          const age = now - stats.mtime.getTime();
          return {
            filename: f,
            size: stats.size,
            mtime: stats.mtime.getTime(),
            age,
            isActive: age < 600000, // Active if modified in last 10 minutes
            formattedAge: formatAge(age)
          };
        } catch (err) {
          return null;
        }
      })
      .filter(f => f !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50); // Latest 50
    
    res.json({ 
      logs: logFiles.map(f => f.filename),
      metadata: logFiles.reduce((acc, f) => {
        acc[f.filename] = {
          size: f.size,
          mtime: f.mtime,
          age: f.age,
          isActive: f.isActive,
          formattedAge: f.formattedAge
        };
        return acc;
      }, {})
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatAge(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

// Get the latest active log file (most recently modified)
app.get('/api/logs/latest', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const filepath = path.join(LOG_DIR, f);
        try {
          const stats = fsSync.statSync(filepath);
          return {
            filename: f,
            mtime: stats.mtime.getTime(),
            size: stats.size
          };
        } catch (err) {
          return null;
        }
      })
      .filter(f => f !== null)
      .sort((a, b) => b.mtime - a.mtime);
    
    if (logFiles.length === 0) {
      return res.json({ filename: null });
    }
    
    res.json({ filename: logFiles[0].filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific log file content
app.get('/api/logs/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(LOG_DIR, filename);
    const content = await fs.readFile(filepath, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: 'Log file not found' });
  }
});

// Start agent
app.post('/api/agent/start', async (req, res) => {
  if (agentProcess && !agentProcess.killed) {
    return res.status(400).json({ error: 'Agent is already running (managed by this dashboard)' });
  }

  // Check for external agents
  const externalPid = await getExternalAgentPid();
  if (externalPid) {
    return res.status(400).json({ 
      error: `Agent is already running externally (PID: ${externalPid}). Stop it first or use the existing process.`,
      externalPid
    });
  }

  const { single, task, maxLoops, loopDelay, autoCommit } = req.body;
  const args = [];

  if (single) args.push('--single');
  if (task) {
    args.push('--task', task);
    args.push('--single');
  }
  if (!autoCommit) args.push('--no-commit');

  const env = {
    ...process.env,
    MAX_LOOPS: maxLoops || 0,
    LOOP_DELAY: loopDelay || 5,
    AUTO_COMMIT: autoCommit !== false ? 'true' : 'false'
  };

  agentProcess = spawn('bash', [AGENT_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  agentProcess.stdout.on('data', (data) => {
    agentEvents.emit('log', { type: 'stdout', data: data.toString() });
  });

  agentProcess.stderr.on('data', (data) => {
    agentEvents.emit('log', { type: 'stderr', data: data.toString() });
  });

  agentProcess.on('exit', (code) => {
    agentEvents.emit('exit', { code });
    agentProcess = null;
  });

  agentEvents.emit('start', { pid: agentProcess.pid });

  res.json({ 
    success: true, 
    pid: agentProcess.pid,
    message: 'Agent started'
  });
});

// Stop agent
app.post('/api/agent/stop', async (req, res) => {
  const { externalPid } = req.body;
  
  // If external PID provided, try to stop that process
  if (externalPid) {
    try {
      // Check if process exists
      await execAsync(`kill -0 ${externalPid}`);
      // Send SIGTERM
      await execAsync(`kill -TERM ${externalPid}`);
      
      // Force kill after 5 seconds
      setTimeout(async () => {
        try {
          await execAsync(`kill -0 ${externalPid}`);
          await execAsync(`kill -KILL ${externalPid}`);
        } catch (err) {
          // Process already dead, ignore
        }
      }, 5000);
      
      return res.json({ success: true, message: `Stop signal sent to external agent (PID: ${externalPid})` });
    } catch (err) {
      return res.status(404).json({ error: `Process ${externalPid} not found or already stopped` });
    }
  }
  
  // Stop our managed process
  if (!agentProcess || agentProcess.killed) {
    return res.status(400).json({ error: 'No agent process managed by this dashboard' });
  }

  agentProcess.kill('SIGTERM');
  
  // Force kill after 5 seconds if still running
  setTimeout(() => {
    if (agentProcess && !agentProcess.killed) {
      agentProcess.kill('SIGKILL');
    }
  }, 5000);

  res.json({ success: true, message: 'Agent stop signal sent' });
});

// Watch a log file and stream updates
const logWatchers = new Map();
const activeLogFiles = new Map(); // Track active log files per process

// Get all active log files (recently modified)
async function getActiveLogFiles(maxAge = 300000) { // 5 minutes default
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const now = Date.now();
    
    const activeFiles = files
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const filepath = path.join(LOG_DIR, f);
        try {
          const stats = fsSync.statSync(filepath);
          const age = now - stats.mtime.getTime();
          return {
            filename: f,
            filepath,
            mtime: stats.mtime.getTime(),
            size: stats.size,
            age,
            isActive: age < maxAge
          };
        } catch (err) {
          return null;
        }
      })
      .filter(f => f !== null)
      .sort((a, b) => b.mtime - a.mtime);
    
    return activeFiles;
  } catch (err) {
    console.error('Error getting active log files:', err);
    return [];
  }
}

function watchLogFile(filename, res, req, options = {}) {
  const filepath = path.join(LOG_DIR, filename);
  let position = 0;
  let retryCount = 0;
  const maxRetries = 10;
  const watchInterval = options.interval || 500;
  let watcher = null;
  let isClosed = false;
  
  const cleanup = () => {
    if (watcher && fsSync.existsSync(filepath)) {
      try {
        fsSync.unwatchFile(filepath, watcher);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
    logWatchers.delete(res);
    isClosed = true;
  };
  
  const sendContent = (content, isNew = false) => {
    if (isClosed || !content) return;
    
    try {
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify({ 
        type: 'file', 
        data: content,
        filename,
        isNew 
      })}\n\n`);
      retryCount = 0; // Reset retry on success
    } catch (err) {
      console.error('Error sending log content:', err);
      cleanup();
    }
  };
  
  // Send existing content
  const readExisting = () => {
    try {
      if (fsSync.existsSync(filepath)) {
        const content = fsSync.readFileSync(filepath, 'utf-8');
        position = content.length;
        if (content) {
          sendContent(content, false);
        }
      }
    } catch (err) {
      console.error('Error reading existing log file:', err);
      if (retryCount < maxRetries && !isClosed) {
        retryCount++;
        setTimeout(readExisting, 1000 * retryCount);
      }
    }
  };
  
  readExisting();
  
  // Watch for changes with error handling
  const startWatching = () => {
    if (isClosed) return;
    
    try {
      if (!fsSync.existsSync(filepath)) {
        // File doesn't exist yet, retry
        if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(startWatching, 1000 * retryCount);
        } else {
          sendContent(`[Log file ${filename} not found yet]\n`, true);
        }
        return;
      }
      
      watcher = fsSync.watchFile(filepath, { interval: watchInterval }, (curr, prev) => {
        if (isClosed) return;
        
        try {
          if (curr.size > prev.size || (prev.size === 0 && curr.size > 0)) {
            // File grew or was created
            if (!fsSync.existsSync(filepath)) {
              return;
            }
            
            const content = fsSync.readFileSync(filepath, 'utf-8');
            if (content.length > position) {
              const newContent = content.substring(position);
              if (newContent) {
                sendContent(newContent, true);
                position = content.length;
              }
            } else if (content.length < position) {
              // File was truncated or rotated, reset position
              sendContent(`[Log file rotated or truncated]\n`, true);
              position = 0;
              if (content) {
                sendContent(content, true);
                position = content.length;
              }
            }
          } else if (curr.size < prev.size) {
            // File was truncated
            sendContent(`[Log file truncated]\n`, true);
            position = 0;
            try {
              const content = fsSync.readFileSync(filepath, 'utf-8');
              if (content) {
                sendContent(content, true);
                position = content.length;
              }
            } catch (err) {
              // Ignore read errors after truncation
            }
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.error('Error reading log file update:', err);
          }
          // If file was deleted, try to find new one
          if (err.code === 'ENOENT' && retryCount < maxRetries) {
            retryCount++;
            setTimeout(() => {
              if (!isClosed) startWatching();
            }, 1000 * retryCount);
          }
        }
      });
      
      logWatchers.set(res, { watcher, filepath, filename });
      retryCount = 0;
    } catch (err) {
      console.error('Error starting file watch:', err);
      if (retryCount < maxRetries && !isClosed) {
        retryCount++;
        setTimeout(startWatching, 1000 * retryCount);
      }
    }
  };
  
  startWatching();
  
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// Server-Sent Events for real-time logs
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onLog = (logData) => {
    sendEvent('log', logData);
  };

  const onStart = (data) => {
    sendEvent('start', data);
  };

  const onExit = (data) => {
    sendEvent('exit', data);
  };

  agentEvents.on('log', onLog);
  agentEvents.on('start', onStart);
  agentEvents.on('exit', onExit);

  // Send initial status (check for external agents too)
  (async () => {
    const allAgents = await findRunningAgents();
    const externalPid = await getExternalAgentPid();
    const isRunning = agentProcess !== null && !agentProcess.killed;
    const hasExternal = externalPid !== null && (!isRunning || externalPid !== agentProcess.pid);
    
    // Separate main and sub-processes
    const mainAgents = allAgents.filter(a => !a.isSubProcess);
    const subAgents = allAgents.filter(a => a.isSubProcess);
    
    sendEvent('status', {
      running: isRunning || hasExternal,
      pid: isRunning ? agentProcess.pid : (hasExternal ? externalPid : null),
      isExternal: hasExternal && !isRunning,
      allAgents: allAgents.map(a => ({ pid: a.pid, comm: a.comm, isSubProcess: a.isSubProcess })),
      subAgents: subAgents.map(a => ({ pid: a.pid, comm: a.comm }))
    });
    
    // Watch active log files for external agents
    if (hasExternal || isRunning) {
      try {
        const activeFiles = await getActiveLogFiles(600000); // 10 minutes
        const activeLogFiles = activeFiles.filter(f => f.isActive);
        
        if (activeLogFiles.length > 0) {
          // Watch the most recent active log file
          watchLogFile(activeLogFiles[0].filename, res, req);
          
          // If there are multiple active files, send info about them
          if (activeLogFiles.length > 1) {
            sendEvent('log', {
              type: 'info',
              data: `[Multiple active log files detected: ${activeLogFiles.length}]\n`
            });
          }
        } else {
          // No active files, try latest file anyway
          const latestFiles = await getActiveLogFiles(3600000); // 1 hour
          if (latestFiles.length > 0) {
            watchLogFile(latestFiles[0].filename, res, req);
          }
        }
      } catch (err) {
        console.error('Error setting up log watching:', err);
      }
    }
  })();

  req.on('close', () => {
    agentEvents.removeListener('log', onLog);
    agentEvents.removeListener('start', onStart);
    agentEvents.removeListener('exit', onExit);
    if (logWatchers.has(res)) {
      const { filepath, watcher } = logWatchers.get(res);
      fsSync.unwatchFile(filepath, watcher);
      logWatchers.delete(res);
    }
  });
});

// Stream a specific log file
app.get('/api/logs/:filename/stream', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(LOG_DIR, filename);
  
  if (!fsSync.existsSync(filepath)) {
    return res.status(404).json({ error: 'Log file not found' });
  }
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  watchLogFile(filename, res, req);
});

// Get task details
app.get('/api/tasks', async (req, res) => {
  try {
    const content = await fs.readFile(ROADMAP_FILE, 'utf-8');
    const tasks = [];
    const lines = content.split('\n');
    
    let currentTask = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const taskMatch = line.match(/^### ([0-9]+\.[0-9]+)\s+(.+)$/);
      
      if (taskMatch) {
        if (currentTask) {
          tasks.push(currentTask);
        }
        currentTask = {
          id: taskMatch[1],
          title: taskMatch[2],
          status: 'PENDING',
          priority: 'P9',
          dependencies: [],
          content: line
        };
      } else if (currentTask) {
        currentTask.content += '\n' + line;
        
        // Extract status
        const statusMatch = line.match(/\*\*Status\*\*:\s*`([A-Z_]+)`/);
        if (statusMatch) {
          currentTask.status = statusMatch[1];
        }
        
        // Extract priority
        const priorityMatch = line.match(/\*\*Priority\*\*:\s*(P[0-9])/);
        if (priorityMatch) {
          currentTask.priority = priorityMatch[1];
        }
        
        // Extract dependencies
        if (line.includes('**Dependencies**:')) {
          const depMatch = line.match(/\*\*Dependencies\*\*:\s*(.+)/);
          if (depMatch) {
            const deps = depMatch[1].match(/[0-9]+\.[0-9]+/g) || [];
            currentTask.dependencies = deps;
          }
        }
        
        // Stop at next section
        if (line.match(/^### [0-9]+\.[0-9]+/) && i > 0) {
          tasks.push(currentTask);
          currentTask = null;
        }
      }
    }
    
    if (currentTask) {
      tasks.push(currentTask);
    }
    
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup on exit
process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  // Stop all log watchers
  for (const [res, { filepath, watcher }] of logWatchers.entries()) {
    try {
      fsSync.unwatchFile(filepath, watcher);
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  logWatchers.clear();
  
  // Kill managed agent process
  if (agentProcess && !agentProcess.killed) {
    agentProcess.kill('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, cleaning up...');
  // Stop all log watchers
  for (const [res, { filepath, watcher }] of logWatchers.entries()) {
    try {
      fsSync.unwatchFile(filepath, watcher);
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  logWatchers.clear();
  
  // Kill managed agent process
  if (agentProcess && !agentProcess.killed) {
    agentProcess.kill('SIGTERM');
  }
  process.exit(0);
});

// Handle uncaught errors gracefully
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Don't exit, keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit, keep server running
});

app.listen(PORT, () => {
  console.log(`Roadmap Dashboard server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
