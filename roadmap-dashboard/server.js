#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const logger = require('./logger');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROADMAP_FILE = path.join(PROJECT_ROOT, 'ROADMAP.md');
const PROMPT_FILE = path.join(PROJECT_ROOT, 'ROADMAP_PROMPT.md');
const LOG_DIR = path.join(PROJECT_ROOT, 'roadmap-logs');
const AGENT_SCRIPT = path.join(PROJECT_ROOT, 'roadmap-agent.sh');
const USER_TASKS_FILE = path.join(PROJECT_ROOT, '.roadmap-user-tasks.json');

// Agent process management
let agentProcess = null;
const agentEvents = new EventEmitter();

// Process detection cache (5 second TTL)
const processCache = {
  data: null,
  timestamp: 0,
  ttl: 5000
};

// Get process info with better parsing
async function getProcessInfo(pid) {
  try {
    // Use ps with more reliable format
    const { stdout } = await execAsync(`ps -p ${pid} -o pid=,ppid=,pgid=,comm=,etime=,args= 2>/dev/null || echo ""`);
    if (!stdout.trim()) return null;
    
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 5) return null;
    
    const procPid = parseInt(parts[0]);
    const ppid = parseInt(parts[1]) || null;
    const pgid = parseInt(parts[2]) || null;
    const comm = parts[3] || '';
    const etime = parts[4] || '';
    const args = parts.slice(5).join(' ') || '';
    
    return {
      pid: procPid,
      ppid,
      pgid,
      comm,
      args,
      etime,
      cmd: `${comm} ${args}`.trim()
    };
  } catch (err) {
    return null;
  }
}

// Check if a process is an agent-related process
function isAgentProcess(proc) {
  if (!proc) return false;
  
  const scriptName = path.basename(AGENT_SCRIPT);
  const cmdLower = proc.cmd.toLowerCase();
  const argsLower = proc.args.toLowerCase();
  
  // Main agent script
  if (cmdLower.includes(scriptName) || argsLower.includes(scriptName)) {
    return true;
  }
  
  // Claude processes with roadmap-related arguments
  if (proc.comm === 'claude' || proc.comm.includes('claude')) {
    const roadmapIndicators = [
      'roadmap',
      'roadmap_prompt.md',
      'roadmap-prompt.md',
      'roadmap.md',
      'task-',
      '--allowedtools'
    ];
    return roadmapIndicators.some(indicator => argsLower.includes(indicator));
  }
  
  return false;
}

// Get process tree (parent and all children) with improved detection
async function getProcessTree(pid, visited = new Set(), depth = 0) {
  if (visited.has(pid) || !pid || depth > 10) return [];
  
  visited.add(pid);
  const processes = [];
  
  const proc = await getProcessInfo(pid);
  if (!proc) return [];
  
  processes.push(proc);
  
  // Find children using pgrep (more reliable than ps)
  try {
    const { stdout } = await execAsync(`pgrep -P ${pid} 2>/dev/null || echo ""`);
    const children = stdout.trim()
      .split('\n')
      .filter(c => c)
      .map(c => parseInt(c))
      .filter(p => !Number.isNaN(p));
    
    for (const childPid of children) {
      const childProcs = await getProcessTree(childPid, visited, depth + 1);
      processes.push(...childProcs);
    }
  } catch (err) {
    // No children or error finding them
  }
  
  return processes;
}

// Find running agent processes including sub-processes (with caching)
async function findRunningAgents(forceRefresh = false) {
  const now = Date.now();
  
  // Return cached data if still valid
  if (!forceRefresh && processCache.data && (now - processCache.timestamp) < processCache.ttl) {
    return processCache.data;
  }
  
  try {
    const scriptName = path.basename(AGENT_SCRIPT);
    const allProcesses = [];
    const visitedPids = new Set();
    
    // Strategy 1: Find processes by script name/path
    const candidatePids = new Set();
    
    try {
      // Find bash processes running the agent script
      const { stdout: bashOut } = await execAsync(
        `ps aux | grep -E "[b]ash.*${scriptName}|[b]ash.*roadmap-agent" | grep -v grep || echo ""`
      );
      const bashLines = bashOut.trim().split('\n').filter(l => l.trim());
      bashLines.forEach(line => {
        const match = line.match(/^\S+\s+(\d+)/);
        if (match) candidatePids.add(parseInt(match[1]));
      });
    } catch (err) {
      // Ignore errors
    }
    
    // Strategy 2: Find by process group (if agent creates one)
    try {
      const { stdout: pgrepOut } = await execAsync(
        `pgrep -f "${scriptName}" 2>/dev/null || echo ""`
      );
      pgrepOut.trim().split('\n').filter(p => p).forEach(pid => {
        candidatePids.add(parseInt(pid));
      });
    } catch (err) {
      // Ignore errors
    }
    
    // Strategy 3: Find claude processes that might be agents
    try {
      const { stdout: claudeOut } = await execAsync(
        `ps aux | grep -E "[c]laude.*roadmap|[c]laude.*PROMPT|[c]laude.*task-" | grep -v grep || echo ""`
      );
      const claudeLines = claudeOut.trim().split('\n').filter(l => l.trim());
      claudeLines.forEach(line => {
        const match = line.match(/^\S+\s+(\d+)/);
        if (match) candidatePids.add(parseInt(match[1]));
      });
    } catch (err) {
      // Ignore errors
    }
    
    // Build process trees for all candidates
    for (const pid of candidatePids) {
      if (visitedPids.has(pid)) continue;
      
      try {
        const tree = await getProcessTree(pid, visitedPids);
        // Filter to only agent-related processes
        const agentProcs = tree.filter(p => isAgentProcess(p));
        allProcesses.push(...agentProcs);
      } catch (err) {
        // Try to at least get the main process
        const proc = await getProcessInfo(pid);
        if (proc && isAgentProcess(proc)) {
          allProcesses.push(proc);
        }
      }
    }
    
    // Deduplicate and categorize
    const unique = new Map();
    const mainAgentPids = new Set();
    
    // First pass: identify main agents
    for (const proc of allProcesses) {
      const scriptNameLower = scriptName.toLowerCase();
      const cmdLower = proc.cmd.toLowerCase();
      if (cmdLower.includes(scriptNameLower) && !proc.comm.includes('claude')) {
        mainAgentPids.add(proc.pid);
      }
    }
    
    // Second pass: categorize all processes
    for (const proc of allProcesses) {
      if (!unique.has(proc.pid)) {
        const isMain = mainAgentPids.has(proc.pid);
        const isSub = !isMain && (proc.comm === 'claude' || proc.comm.includes('claude'));
        const isExternal = !agentProcess || proc.pid !== agentProcess.pid;
        
        unique.set(proc.pid, {
          pid: proc.pid,
          ppid: proc.ppid,
          pgid: proc.pgid,
          comm: proc.comm,
          cmd: proc.cmd,
          args: proc.args,
          etime: proc.etime,
          isExternal,
          isSubProcess: isSub,
          isMainProcess: isMain
        });
      }
    }
    
    const result = Array.from(unique.values());
    
    // Update cache
    processCache.data = result;
    processCache.timestamp = now;
    
    return result;
  } catch (err) {
    logger.error('Failed to find running agents:', err.message);
    return processCache.data || [];
  }
}

// Verify process is still running and is still an agent
async function verifyProcess(pid) {
  try {
    // Check if process exists
    await execAsync(`kill -0 ${pid} 2>/dev/null`);
    
    // Verify it's still an agent process
    const proc = await getProcessInfo(pid);
    return proc && isAgentProcess(proc);
  } catch (err) {
    return false;
  }
}

// Verify multiple processes efficiently
async function verifyProcesses(agents) {
  const verified = [];
  const checkPromises = agents.map(async (agent) => {
    const isValid = await verifyProcess(agent.pid);
    return isValid ? agent : null;
  });
  
  const results = await Promise.all(checkPromises);
  return results.filter(a => a !== null);
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const allAgents = await findRunningAgents(true); // Force refresh for health check
    const verifiedAgents = await verifyProcesses(allAgents);
    
    const activeFiles = await getActiveLogFiles(600000);
    
    const mainAgents = verifiedAgents.filter(a => a.isMainProcess);
    const subAgents = verifiedAgents.filter(a => a.isSubProcess);
    
    res.json({
      status: 'healthy',
      timestamp: Date.now(),
      agents: {
        total: verifiedAgents.length,
        main: mainAgents.length,
        subProcesses: subAgents.length,
        external: verifiedAgents.filter(a => a.isExternal).length
      },
      logs: {
        activeFiles: activeFiles.filter(f => f.isActive).length,
        totalFiles: activeFiles.length
      },
      watchers: logWatchers.size,
      cacheAge: Date.now() - processCache.timestamp
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
  
  // Verify processes are still running
  const verifiedAgents = await verifyProcesses(agents);
  if (verifiedAgents.length === 0) return null;
  
  // Prefer main processes, then external, then any
  const mainAgents = verifiedAgents.filter(a => a.isMainProcess);
  const externalAgents = verifiedAgents.filter(a => a.isExternal);
  
  if (mainAgents.length > 0) {
    return mainAgents[0].pid;
  }
  if (externalAgents.length > 0) {
    return externalAgents[0].pid;
  }
  return verifiedAgents[0].pid;
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
  const verifiedAgents = await verifyProcesses(allAgents);
  
  const externalPid = await getExternalAgentPid();
  const hasExternalAgent = externalPid !== null && (!isRunning || externalPid !== agentProcess.pid);
  
  // Separate sub-processes
  const subAgents = verifiedAgents.filter(a => a.isSubProcess);
  
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
    
    // Extract header stats
    const headerMatch = content.match(/\*\*Total Tasks\*\*:\s*(\d+)/);
    if (headerMatch) stats.total = parseInt(headerMatch[1]);
    
    stats.done = (content.match(/`DONE`/g) || []).length;
    stats.inProgress = (content.match(/`IN_PROGRESS`/g) || []).length;
    stats.blocked = (content.match(/`BLOCKED`/g) || []).length;
    stats.pending = stats.total - stats.done - stats.inProgress - stats.blocked;
  } catch (err) {
    logger.warn('Failed to read ROADMAP.md:', err.message);
  }

  res.json({
    running: isRunning || hasExternalAgent,
    pid: isRunning ? agentProcess.pid : (hasExternalAgent ? externalPid : null),
    isExternal: hasExternalAgent && !isRunning,
    externalAgents: verifiedAgents
      .filter(a => a.isExternal || !isRunning)
      .map(a => ({ 
        pid: a.pid, 
        cmd: a.cmd,
        comm: a.comm,
        isSubProcess: a.isSubProcess,
        isMainProcess: a.isMainProcess
      })),
    allAgents: verifiedAgents.map(a => ({
      pid: a.pid,
      comm: a.comm,
      isSubProcess: a.isSubProcess,
      isMainProcess: a.isMainProcess,
      isExternal: a.isExternal
    })),
    subAgents: subAgents.map(a => ({
      pid: a.pid,
      comm: a.comm
    })),
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

// Extract task ID from log filename
function extractTaskIdFromLog(filename) {
  const match = filename.match(/^task-([0-9]+\.[0-9]+)-/);
  return match ? match[1] : null;
}

// Get list of log files with metadata and process associations
app.get('/api/logs', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const now = Date.now();
    
    // Get running agents to match with log files
    const runningAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(runningAgents);
    
    // Create a map of task IDs to processes (if we can infer from command line)
    const taskToProcessMap = new Map();
    verifiedAgents.forEach(agent => {
      // Try to extract task ID from command line arguments
      const taskMatch = agent.cmd.match(/task[_-]?([0-9]+\.[0-9]+)/i) || 
                       agent.args.match(/task[_-]?([0-9]+\.[0-9]+)/i);
      if (taskMatch) {
        taskToProcessMap.set(taskMatch[1], agent);
      }
    });
    
    const logFiles = files
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const filepath = path.join(LOG_DIR, f);
        try {
          const stats = fsSync.statSync(filepath);
          const age = now - stats.mtime.getTime();
          const taskId = extractTaskIdFromLog(f);
          const associatedProcess = taskId ? taskToProcessMap.get(taskId) : null;
          
          // Check if file is currently being written to (more accurate than just mtime)
          const isActive = age < 600000; // Active if modified in last 10 minutes
          const isCurrentlyActive = age < 30000; // Very active if modified in last 30 seconds
          
          return {
            filename: f,
            size: stats.size,
            mtime: stats.mtime.getTime(),
            age,
            isActive,
            isCurrentlyActive,
            formattedAge: formatAge(age),
            taskId,
            associatedPid: associatedProcess ? associatedProcess.pid : null,
            associatedComm: associatedProcess ? associatedProcess.comm : null
          };
        } catch (err) {
          return null;
        }
      })
      .filter(f => f !== null)
      .sort((a, b) => {
        // Sort by: currently active first, then active, then by mtime
        if (a.isCurrentlyActive !== b.isCurrentlyActive) {
          return b.isCurrentlyActive - a.isCurrentlyActive;
        }
        if (a.isActive !== b.isActive) {
          return b.isActive - a.isActive;
        }
        return b.mtime - a.mtime;
      })
      .slice(0, 100); // Latest 100
    
    res.json({ 
      logs: logFiles.map(f => f.filename),
      metadata: logFiles.reduce((acc, f) => {
        acc[f.filename] = {
          size: f.size,
          mtime: f.mtime,
          age: f.age,
          isActive: f.isActive,
          isCurrentlyActive: f.isCurrentlyActive,
          formattedAge: f.formattedAge,
          taskId: f.taskId,
          associatedPid: f.associatedPid,
          associatedComm: f.associatedComm
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

// Get specific log file content with metadata
app.get('/api/logs/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(LOG_DIR, filename);
    
    // Check if file exists
    if (!fsSync.existsSync(filepath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    
    const stats = fsSync.statSync(filepath);
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit
    
    // Check file size and warn if too large
    let content;
    let truncated = false;
    if (stats.size > MAX_FILE_SIZE) {
      // Read only the last portion of very large files
      const fd = fsSync.openSync(filepath, 'r');
      const buffer = Buffer.alloc(Math.min(MAX_FILE_SIZE, stats.size));
      const startPos = Math.max(0, stats.size - MAX_FILE_SIZE);
      fsSync.readSync(fd, buffer, 0, buffer.length, startPos);
      fsSync.closeSync(fd);
      content = buffer.toString('utf-8');
      truncated = true;
      logger.warn(`Log file ${filename} is ${(stats.size / 1024 / 1024).toFixed(2)}MB, truncating to last ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)}MB`);
    } else {
      content = await fs.readFile(filepath, 'utf-8');
    }
    
    const taskId = extractTaskIdFromLog(filename);
    
    // Try to find associated process
    let associatedProcess = null;
    if (taskId) {
      const runningAgents = await findRunningAgents(true);
      const verifiedAgents = await verifyProcesses(runningAgents);
      const taskMatch = verifiedAgents.find(agent => {
        const match = agent.cmd.match(/task[_-]?([0-9]+\.[0-9]+)/i) || 
                     agent.args.match(/task[_-]?([0-9]+\.[0-9]+)/i);
        return match && match[1] === taskId;
      });
      if (taskMatch) {
        associatedProcess = {
          pid: taskMatch.pid,
          comm: taskMatch.comm,
          cmd: taskMatch.cmd
        };
      }
    }
    
    res.json({ 
      content: truncated ? `[File truncated - showing last ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)}MB of ${(stats.size / 1024 / 1024).toFixed(2)}MB]\n${content}` : content,
      metadata: {
        filename,
        size: stats.size,
        mtime: stats.mtime.getTime(),
        taskId,
        associatedProcess,
        truncated
      }
    });
  } catch (err) {
    logger.error('Failed to read log file:', err.message);
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Log file not found' });
    } else {
      res.status(500).json({ error: `Failed to read log file: ${err.message}` });
    }
  }
});

// Invalidate process cache
function invalidateProcessCache() {
  processCache.data = null;
  processCache.timestamp = 0;
}

// Start agent
app.post('/api/agent/start', async (req, res) => {
  if (agentProcess && !agentProcess.killed) {
    return res.status(400).json({ error: 'Agent is already running (managed by this dashboard)' });
  }

  // Invalidate cache before checking
  invalidateProcessCache();
  
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

  const currentProcess = agentProcess;
  agentProcess.on('exit', (code) => {
    agentEvents.emit('exit', { code });
    // Only clear if this is still the current process (not replaced by a new start)
    if (agentProcess === currentProcess) {
      agentProcess = null;
    }
    invalidateProcessCache(); // Clear cache when agent exits
  });

  agentEvents.emit('start', { pid: agentProcess.pid });
  invalidateProcessCache(); // Clear cache when agent starts

  res.json({ 
    success: true, 
    pid: agentProcess.pid,
    message: 'Agent started'
  });
});

// Stop agent
app.post('/api/agent/stop', async (req, res) => {
  const { externalPid } = req.body;
  
  // Invalidate cache before stopping
  invalidateProcessCache();
  
  // If external PID provided, try to stop that process and its children
  if (externalPid) {
    try {
      // Check if process exists
      await execAsync(`kill -0 ${externalPid}`);
      
      // Get process group to kill entire tree
      const proc = await getProcessInfo(externalPid);
      if (proc && proc.pgid) {
        // Try to kill process group (more reliable for killing children)
        try {
          await execAsync(`kill -TERM -${proc.pgid} 2>/dev/null || kill -TERM ${externalPid}`);
        } catch (err) {
          // Fallback to just the PID
          await execAsync(`kill -TERM ${externalPid}`);
        }
      } else {
        // Send SIGTERM to process and its children
        await execAsync(`pkill -TERM -P ${externalPid} 2>/dev/null || true`);
        await execAsync(`kill -TERM ${externalPid}`);
      }
      
      // Force kill after 5 seconds
      setTimeout(async () => {
        try {
          await execAsync(`kill -0 ${externalPid}`);
          if (proc && proc.pgid) {
            await execAsync(`kill -KILL -${proc.pgid} 2>/dev/null || kill -KILL ${externalPid}`);
          } else {
            await execAsync(`pkill -KILL -P ${externalPid} 2>/dev/null || true`);
            await execAsync(`kill -KILL ${externalPid}`);
          }
        } catch (err) {
          // Process already dead, ignore
        }
        invalidateProcessCache(); // Clear cache after force kill
      }, 5000);
      
      invalidateProcessCache(); // Clear cache after stop signal
      return res.json({ success: true, message: `Stop signal sent to external agent (PID: ${externalPid})` });
    } catch (err) {
      return res.status(404).json({ error: `Process ${externalPid} not found or already stopped` });
    }
  }
  
  // Stop our managed process
  if (!agentProcess || agentProcess.killed) {
    return res.status(400).json({ error: 'No agent process managed by this dashboard' });
  }

  const processToKill = agentProcess;
  agentProcess.kill('SIGTERM');
  
  // Clear the reference immediately so we can start again
  agentProcess = null;
  
  // Force kill after 5 seconds if still running
  setTimeout(() => {
    if (processToKill && !processToKill.killed) {
      processToKill.kill('SIGKILL');
    }
    invalidateProcessCache(); // Clear cache after force kill
  }, 5000);

  invalidateProcessCache(); // Clear cache after stop signal
  res.json({ success: true, message: 'Agent stop signal sent' });
});

// Watch a log file and stream updates
const logWatchers = new Map();
const activeLogFiles = new Map(); // Track active log files per process

// Get all active log files (recently modified) with process associations
async function getActiveLogFiles(maxAge = 300000) { // 5 minutes default
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const now = Date.now();
    
    // Get running agents to match with log files
    const runningAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(runningAgents);
    
    // Create a map of task IDs to processes
    const taskToProcessMap = new Map();
    verifiedAgents.forEach(agent => {
      const cmd = agent.cmd || '';
      const args = agent.args || '';
      const taskMatch = cmd.match(/task[_-]?([0-9]+\.[0-9]+)/i) ||
                       args.match(/task[_-]?([0-9]+\.[0-9]+)/i);
      if (taskMatch) {
        taskToProcessMap.set(taskMatch[1], agent);
      }
    });
    
    const activeFiles = files
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const filepath = path.join(LOG_DIR, f);
        try {
          const stats = fsSync.statSync(filepath);
          const age = now - stats.mtime.getTime();
          const taskId = extractTaskIdFromLog(f);
          const associatedProcess = taskId ? taskToProcessMap.get(taskId) : null;
          
          return {
            filename: f,
            filepath,
            mtime: stats.mtime.getTime(),
            size: stats.size,
            age,
            isActive: age < maxAge,
            taskId,
            associatedPid: associatedProcess ? associatedProcess.pid : null,
            associatedComm: associatedProcess ? associatedProcess.comm : null
          };
        } catch (err) {
          return null;
        }
      })
      .filter(f => f !== null)
      .sort((a, b) => {
        // Sort by: active first, then by mtime
        if (a.isActive !== b.isActive) {
          return b.isActive - a.isActive;
        }
        return b.mtime - a.mtime;
      });
    
    return activeFiles;
  } catch (err) {
    logger.error('Failed to get active log files:', err.message);
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
  let lastModified = 0;
  let checkCount = 0;
  
  const cleanup = () => {
    if (isClosed) return; // Prevent double cleanup
    isClosed = true;
    
    if (watcher) {
      try {
        // Always try to unwatch, even if file doesn't exist
        fsSync.unwatchFile(filepath, watcher);
      } catch (err) {
        // Ignore cleanup errors (file might not exist, watcher might already be removed)
        logger.debug('Cleanup unwatch error (expected):', err.message);
      }
    }
    logWatchers.delete(res);
  };
  
  const sendContent = (content, isNew = false) => {
    if (isClosed || !content) return false;
    
    // Check if response is still writable
    if (res.destroyed || !res.writable || res.closed) {
      cleanup();
      return false;
    }
    
    try {
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify({ 
        type: 'file', 
        data: content,
        filename,
        isNew 
      })}\n\n`);
      retryCount = 0; // Reset retry on success
      return true;
    } catch (err) {
      logger.debug('Failed to send log content:', err.message);
      cleanup();
      return false;
    }
  };
  
  // Check if file is actively being written (modified recently)
  const isFileActive = () => {
    try {
      if (!fsSync.existsSync(filepath)) return false;
      const stats = fsSync.statSync(filepath);
      const now = Date.now();
      const age = now - stats.mtime.getTime();
      return age < 30000; // Active if modified in last 30 seconds
    } catch (err) {
      return false;
    }
  };
  
  // Send existing content
  const readExisting = () => {
    try {
      if (fsSync.existsSync(filepath)) {
        const stats = fsSync.statSync(filepath);
        const MAX_INITIAL_SIZE = 10 * 1024 * 1024; // 10MB limit for initial read
        
        let content;
        if (stats.size > MAX_INITIAL_SIZE) {
          // For large files, only read the tail
          const fd = fsSync.openSync(filepath, 'r');
          const buffer = Buffer.alloc(Math.min(MAX_INITIAL_SIZE, stats.size));
          const startPos = Math.max(0, stats.size - MAX_INITIAL_SIZE);
          fsSync.readSync(fd, buffer, 0, buffer.length, startPos);
          fsSync.closeSync(fd);
          content = buffer.toString('utf-8');
          position = stats.size; // Set position to end of file
          logger.debug(`Log file ${filename} is large (${(stats.size / 1024 / 1024).toFixed(2)}MB), reading tail only`);
        } else {
          content = fsSync.readFileSync(filepath, 'utf-8');
          position = content.length;
        }
        
        lastModified = stats.mtime.getTime();
        if (content) {
          sendContent(content, false);
        }
      }
    } catch (err) {
      logger.debug('Failed to read existing log file:', err.message);
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
          checkCount++;
          const now = Date.now();
          const fileAge = now - curr.mtime.getTime();
          const isActive = fileAge < 30000;
          
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
                lastModified = curr.mtime.getTime();
              }
            } else if (content.length < position) {
              // File was truncated or rotated, reset position
              sendContent(`[Log file rotated or truncated]\n`, true);
              position = 0;
              if (content) {
                sendContent(content, true);
                position = content.length;
                lastModified = curr.mtime.getTime();
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
                lastModified = curr.mtime.getTime();
              }
            } catch (err) {
              // Ignore read errors after truncation
            }
          }
          
          // Periodically check if we should switch to a more active file
          // (every 20 checks, roughly every 10 seconds)
          if (checkCount % 20 === 0 && !isActive) {
            // File hasn't been modified recently, might want to switch
            // But don't auto-switch, just log it
            // The frontend can handle switching based on this info
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.debug('Failed to read log file update:', err.message);
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
      logger.warn('Failed to start file watch:', err.message);
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
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  let isConnected = true;
  
  // Check if response is still writable
  const isWritable = () => {
    return isConnected && !res.destroyed && res.writable && !res.closed;
  };

  const sendEvent = (event, data) => {
    if (!isWritable()) return false;
    
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (err) {
      logger.debug('Failed to send SSE event:', err.message);
      isConnected = false;
      return false;
    }
  };

  // Send heartbeat/ping every 30 seconds to keep connection alive
  const heartbeatInterval = setInterval(() => {
    if (!sendEvent('ping', { timestamp: Date.now() })) {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  const onLog = (logData) => {
    if (!sendEvent('log', logData)) {
      agentEvents.removeListener('log', onLog);
      agentEvents.removeListener('start', onStart);
      agentEvents.removeListener('exit', onExit);
      clearInterval(heartbeatInterval);
    }
  };

  const onStart = (data) => {
    if (!sendEvent('start', data)) {
      agentEvents.removeListener('log', onLog);
      agentEvents.removeListener('start', onStart);
      agentEvents.removeListener('exit', onExit);
      clearInterval(heartbeatInterval);
    }
  };

  const onExit = (data) => {
    if (!sendEvent('exit', data)) {
      agentEvents.removeListener('log', onLog);
      agentEvents.removeListener('start', onStart);
      agentEvents.removeListener('exit', onExit);
      clearInterval(heartbeatInterval);
    }
  };

  agentEvents.on('log', onLog);
  agentEvents.on('start', onStart);
  agentEvents.on('exit', onExit);

  // Send initial status (check for external agents too)
  (async () => {
    const allAgents = await findRunningAgents(true); // Force refresh for initial status
    const verifiedAgents = await verifyProcesses(allAgents);
    const externalPid = await getExternalAgentPid();
    const isRunning = agentProcess !== null && !agentProcess.killed;
    const hasExternal = externalPid !== null && (!isRunning || externalPid !== agentProcess.pid);
    
    // Separate sub-processes
    const subAgents = verifiedAgents.filter(a => a.isSubProcess);
    
    sendEvent('status', {
      running: isRunning || hasExternal,
      pid: isRunning ? agentProcess.pid : (hasExternal ? externalPid : null),
      isExternal: hasExternal && !isRunning,
      allAgents: verifiedAgents.map(a => ({ 
        pid: a.pid, 
        comm: a.comm, 
        isSubProcess: a.isSubProcess,
        isMainProcess: a.isMainProcess 
      })),
      subAgents: subAgents.map(a => ({ pid: a.pid, comm: a.comm })),
      externalAgents: verifiedAgents
        .filter(a => a.isExternal || !isRunning)
        .map(a => ({ pid: a.pid, cmd: a.cmd, comm: a.comm }))
    });
    
    // Watch active log files for external agents
    if (hasExternal || isRunning) {
      try {
        // Check if we already have a watcher for this response
        if (!logWatchers.has(res)) {
          const activeFiles = await getActiveLogFiles(600000); // 10 minutes
          const activeLogFiles = activeFiles.filter(f => f.isActive);
          
          if (activeLogFiles.length > 0) {
            // Prefer log files associated with running processes
            const processAssociatedFiles = activeLogFiles.filter(f => f.associatedPid);
            const fileToWatch = processAssociatedFiles.length > 0 
              ? processAssociatedFiles[0] 
              : activeLogFiles[0];
            
            watchLogFile(fileToWatch.filename, res, req);
            
            // Send metadata about the watched file
            sendEvent('log', {
              type: 'info',
              data: `[Watching log: ${fileToWatch.filename}${fileToWatch.taskId ? ` (Task ${fileToWatch.taskId})` : ''}${fileToWatch.associatedPid ? ` - PID ${fileToWatch.associatedPid}` : ''}]\n`
            });
            
            // If there are multiple active files, send info about them
            if (activeLogFiles.length > 1) {
              sendEvent('log', {
                type: 'info',
                data: `[${activeLogFiles.length - 1} other active log file(s) detected]\n`
              });
            }
          } else {
            // No active files, try latest file anyway
            const latestFiles = await getActiveLogFiles(3600000); // 1 hour
            if (latestFiles.length > 0) {
              watchLogFile(latestFiles[0].filename, res, req);
              sendEvent('log', {
                type: 'info',
                data: `[Watching latest log: ${latestFiles[0].filename}]\n`
              });
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to setup log watching:', err.message);
      }
    }
  })();

  // Handle client disconnect
  const cleanup = () => {
    if (!isConnected) return; // Already cleaned up
    isConnected = false;
    
    clearInterval(heartbeatInterval);
    agentEvents.removeListener('log', onLog);
    agentEvents.removeListener('start', onStart);
    agentEvents.removeListener('exit', onExit);
    
    if (logWatchers.has(res)) {
      try {
        const { filepath, watcher } = logWatchers.get(res);
        if (watcher) {
          fsSync.unwatchFile(filepath, watcher);
        }
      } catch (err) {
        // Ignore cleanup errors
        logger.debug('Request close cleanup error:', err.message);
      }
      logWatchers.delete(res);
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  res.on('finish', cleanup);
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

// User Tasks API
// Load user tasks from file
async function loadUserTasks() {
  try {
    const content = await fs.readFile(USER_TASKS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { tasks: [], nextId: 1 };
    }
    throw err;
  }
}

// Save user tasks to file
async function saveUserTasks(data) {
  await fs.writeFile(USER_TASKS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Get all user tasks
app.get('/api/user-tasks', async (req, res) => {
  try {
    const data = await loadUserTasks();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new user task
app.post('/api/user-tasks', async (req, res) => {
  try {
    const { title, description, priority, assignToAgent } = req.body;
    
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const data = await loadUserTasks();
    const task = {
      id: `user-${data.nextId}`,
      title: title.trim(),
      description: description || '',
      priority: priority || 'P5',
      status: assignToAgent ? 'ASSIGNED' : 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignedAt: assignToAgent ? new Date().toISOString() : null,
      completedAt: null,
      agentPid: null,
      reviewStatus: null,
      reviewNotes: null
    };
    
    data.tasks.push(task);
    data.nextId++;
    await saveUserTasks(data);
    
    // If assigned to agent, start agent with this task
    if (assignToAgent) {
      // Queue task assignment (will be picked up by agent)
      task.agentPid = 'pending';
    }
    
    res.json({ task, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a user task
app.put('/api/user-tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const data = await loadUserTasks();
    const taskIndex = data.tasks.findIndex(t => t.id === id);
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const task = data.tasks[taskIndex];
    
    // Update allowed fields
    if (updates.title !== undefined) task.title = updates.title.trim();
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.reviewStatus !== undefined) task.reviewStatus = updates.reviewStatus;
    if (updates.reviewNotes !== undefined) task.reviewNotes = updates.reviewNotes;
    
    // Handle assignment
    if (updates.assignToAgent === true && task.status !== 'ASSIGNED' && task.status !== 'IN_PROGRESS') {
      task.status = 'ASSIGNED';
      task.assignedAt = new Date().toISOString();
      task.agentPid = 'pending';
    }
    
    // Handle completion
    if (updates.status === 'COMPLETED' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    }
    
    task.updatedAt = new Date().toISOString();
    
    await saveUserTasks(data);
    res.json({ task, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a user task
app.delete('/api/user-tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const data = await loadUserTasks();
    const taskIndex = data.tasks.findIndex(t => t.id === id);
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    data.tasks.splice(taskIndex, 1);
    await saveUserTasks(data);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign a user task to agent
app.post('/api/user-tasks/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { taskId } = req.body; // Optional roadmap task ID to map to
    
    const data = await loadUserTasks();
    const task = data.tasks.find(t => t.id === id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    if (task.status === 'IN_PROGRESS' || task.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Task is already in progress or completed' });
    }
    
    task.status = 'ASSIGNED';
    task.assignedAt = new Date().toISOString();
    task.agentPid = 'pending';
    task.roadmapTaskId = taskId || null;
    task.updatedAt = new Date().toISOString();
    
    await saveUserTasks(data);
    
    res.json({ task, success: true, message: 'Task assigned to agent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Review/approve a user task
app.post('/api/user-tasks/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body; // status: 'approved', 'rejected', 'needs_revision'
    
    if (!status || !['approved', 'rejected', 'needs_revision'].includes(status)) {
      return res.status(400).json({ error: 'Invalid review status' });
    }
    
    const data = await loadUserTasks();
    const task = data.tasks.find(t => t.id === id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    task.reviewStatus = status;
    task.reviewNotes = notes || null;
    task.reviewedAt = new Date().toISOString();
    
    if (status === 'approved') {
      task.status = 'COMPLETED';
      task.completedAt = new Date().toISOString();
    } else if (status === 'needs_revision') {
      task.status = 'PENDING';
      task.assignedAt = null;
      task.agentPid = null;
    }
    
    task.updatedAt = new Date().toISOString();
    
    await saveUserTasks(data);
    
    res.json({ task, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent API: Create user task (for agents to call programmatically)
app.post('/api/agent/user-tasks', async (req, res) => {
  try {
    const { title, description, priority, assignToAgent, sourceTaskId, sourceAgent } = req.body;
    
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const data = await loadUserTasks();
    const task = {
      id: `user-${data.nextId}`,
      title: title.trim(),
      description: description || '',
      priority: priority || 'P5',
      status: assignToAgent ? 'ASSIGNED' : 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignedAt: assignToAgent ? new Date().toISOString() : null,
      completedAt: null,
      agentPid: assignToAgent ? 'pending' : null,
      reviewStatus: null,
      reviewNotes: null,
      sourceTaskId: sourceTaskId || null,
      sourceAgent: sourceAgent || 'roadmap-agent',
      createdBy: 'agent'
    };
    
    data.tasks.push(task);
    data.nextId++;
    await saveUserTasks(data);
    
    res.json({ task, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup on exit
process.on('SIGTERM', () => {
  logger.info('Shutting down (SIGTERM)...');
  cleanup();
});

process.on('SIGINT', () => {
  logger.info('Shutting down (SIGINT)...');
  cleanup();
});

function cleanup() {
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
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message);
  logger.debug('Stack:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('Unhandled rejection:', message);
});

app.listen(PORT, () => {
  logger.info(`Server started on http://localhost:${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/api/health`);
});
