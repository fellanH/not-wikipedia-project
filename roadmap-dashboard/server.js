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
const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROADMAP_FILE = path.join(PROJECT_ROOT, 'ROADMAP.md');
const PROMPT_FILE = path.join(PROJECT_ROOT, 'ROADMAP_PROMPT.md');
const LOG_DIR = path.join(PROJECT_ROOT, 'roadmap-logs');
const AGENT_SCRIPT = path.join(PROJECT_ROOT, 'roadmap-agent.sh');
const USER_TASKS_FILE = path.join(PROJECT_ROOT, '.roadmap-user-tasks.json');

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3001', 'http://127.0.0.1:3001'];

let agentProcess = null;
const agentEvents = new EventEmitter();

const processCache = {
  data: null,
  timestamp: 0,
  ttl: 5000
};

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 100;

let server = null;
let isShuttingDown = false;
const activeConnections = new Set();

function validatePid(pid) {
  const parsed = parseInt(pid, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 4194304 || String(parsed) !== String(pid)) {
    return null;
  }
  return parsed;
}

function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }
  const sanitized = path.basename(filename);
  if (sanitized !== filename || sanitized.includes('..') || !sanitized.endsWith('.log')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._-]+\.log$/.test(sanitized)) {
    return null;
  }
  return sanitized;
}

function sanitizeString(str, maxLength = 1000) {
  if (!str || typeof str !== 'string') return '';
  return str.slice(0, maxLength).replace(/[<>]/g, '');
}

function rateLimit(req, res, next) {
  if (isShuttingDown) {
    return res.status(503).json({ error: 'Server shutting down' });
  }

  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  const record = rateLimitMap.get(ip);
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }

  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    res.set('Retry-After', Math.ceil((record.resetTime - now) / 1000));
    return res.status(429).json({ error: 'Too many requests' });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 60000);

async function getProcessInfo(pid) {
  const validPid = validatePid(pid);
  if (!validPid) return null;

  try {
    const { stdout } = await execAsync(`ps -p ${validPid} -o pid=,ppid=,pgid=,comm=,etime=,args= 2>/dev/null || echo ""`);
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

function isAgentProcess(proc) {
  if (!proc) return false;

  const scriptName = path.basename(AGENT_SCRIPT);
  const cmdLower = proc.cmd.toLowerCase();
  const argsLower = proc.args.toLowerCase();

  if (cmdLower.includes(scriptName) || argsLower.includes(scriptName)) {
    return true;
  }

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

async function getProcessTree(pid, visited = new Set(), depth = 0) {
  const validPid = validatePid(pid);
  if (!validPid || visited.has(validPid) || depth > 10) return [];

  visited.add(validPid);
  const processes = [];

  const proc = await getProcessInfo(validPid);
  if (!proc) return [];

  processes.push(proc);

  try {
    const { stdout } = await execAsync(`pgrep -P ${validPid} 2>/dev/null || echo ""`);
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
    logger.debug('Error getting process children:', err.message);
  }

  return processes;
}

async function findRunningAgents(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && processCache.data && (now - processCache.timestamp) < processCache.ttl) {
    return processCache.data;
  }

  try {
    const scriptName = path.basename(AGENT_SCRIPT);
    const allProcesses = [];
    const visitedPids = new Set();

    const candidatePids = new Set();

    try {
      const { stdout: bashOut } = await execAsync(
        `ps aux | grep -E "[b]ash.*${scriptName}|[b]ash.*roadmap-agent" | grep -v grep || echo ""`
      );
      const bashLines = bashOut.trim().split('\n').filter(l => l.trim());
      bashLines.forEach(line => {
        const match = line.match(/^\S+\s+(\d+)/);
        if (match) {
          const pid = validatePid(match[1]);
          if (pid) candidatePids.add(pid);
        }
      });
    } catch (err) {
      logger.debug('Error finding bash processes:', err.message);
    }

    try {
      const { stdout: pgrepOut } = await execAsync(
        `pgrep -f "${scriptName}" 2>/dev/null || echo ""`
      );
      pgrepOut.trim().split('\n').filter(p => p).forEach(p => {
        const pid = validatePid(p);
        if (pid) candidatePids.add(pid);
      });
    } catch (err) {
      logger.debug('Error with pgrep:', err.message);
    }

    try {
      const { stdout: claudeOut } = await execAsync(
        `ps aux | grep -E "[c]laude.*roadmap|[c]laude.*PROMPT|[c]laude.*task-" | grep -v grep || echo ""`
      );
      const claudeLines = claudeOut.trim().split('\n').filter(l => l.trim());
      claudeLines.forEach(line => {
        const match = line.match(/^\S+\s+(\d+)/);
        if (match) {
          const pid = validatePid(match[1]);
          if (pid) candidatePids.add(pid);
        }
      });
    } catch (err) {
      logger.debug('Error finding claude processes:', err.message);
    }

    for (const pid of candidatePids) {
      if (visitedPids.has(pid)) continue;

      try {
        const tree = await getProcessTree(pid, visitedPids);
        const agentProcs = tree.filter(p => isAgentProcess(p));
        allProcesses.push(...agentProcs);
      } catch (err) {
        const proc = await getProcessInfo(pid);
        if (proc && isAgentProcess(proc)) {
          allProcesses.push(proc);
        }
      }
    }

    const unique = new Map();
    const mainAgentPids = new Set();

    for (const proc of allProcesses) {
      const scriptNameLower = scriptName.toLowerCase();
      const cmdLower = proc.cmd.toLowerCase();
      if (cmdLower.includes(scriptNameLower) && !proc.comm.includes('claude')) {
        mainAgentPids.add(proc.pid);
      }
    }

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

    processCache.data = result;
    processCache.timestamp = now;

    return result;
  } catch (err) {
    logger.error('Failed to find running agents:', err.message);
    return processCache.data || [];
  }
}

async function verifyProcess(pid) {
  const validPid = validatePid(pid);
  if (!validPid) return false;

  try {
    await execAsync(`kill -0 ${validPid} 2>/dev/null`);
    const proc = await getProcessInfo(validPid);
    return proc && isAgentProcess(proc);
  } catch (err) {
    return false;
  }
}

async function verifyProcesses(agents) {
  const checkPromises = agents.map(async (agent) => {
    const isValid = await verifyProcess(agent.pid);
    return isValid ? agent : null;
  });

  const results = await Promise.all(checkPromises);
  return results.filter(a => a !== null);
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; font-src 'self';"
  });
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    const allAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(allAgents);

    const activeFiles = await getActiveLogFiles(600000);

    const mainAgents = verifiedAgents.filter(a => a.isMainProcess);
    const subAgents = verifiedAgents.filter(a => a.isSubProcess);

    let roadmapReadable = false;
    try {
      await fs.access(ROADMAP_FILE, fsSync.constants.R_OK);
      roadmapReadable = true;
    } catch (err) {
      logger.warn('ROADMAP.md not readable');
    }

    res.json({
      status: roadmapReadable ? 'healthy' : 'degraded',
      timestamp: Date.now(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
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
      cacheAge: Date.now() - processCache.timestamp,
      dependencies: {
        roadmapFile: roadmapReadable
      }
    });
  } catch (err) {
    logger.error('Health check failed:', err.message);
    res.status(500).json({
      status: 'error',
      error: err.message,
      timestamp: Date.now()
    });
  }
});

async function getExternalAgentPid() {
  const agents = await findRunningAgents();
  if (agents.length === 0) return null;

  const verifiedAgents = await verifyProcesses(agents);
  if (verifiedAgents.length === 0) return null;

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

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(rateLimit);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.get('/api/status', async (req, res) => {
  try {
    const isRunning = agentProcess !== null && !agentProcess.killed;
    const allAgents = await findRunningAgents();

    const verifiedAgents = await verifyProcesses(allAgents);

    const externalPid = await getExternalAgentPid();
    const hasExternalAgent = externalPid !== null && (!isRunning || externalPid !== agentProcess.pid);

    const subAgents = verifiedAgents.filter(a => a.isSubProcess);

    let stats = {
      total: 0,
      done: 0,
      inProgress: 0,
      pending: 0,
      blocked: 0
    };

    try {
      const content = await fs.readFile(ROADMAP_FILE, 'utf-8');

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
          cmd: sanitizeString(a.cmd, 200),
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
  } catch (err) {
    logger.error('Status endpoint error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/roadmap', async (req, res) => {
  try {
    const content = await fs.readFile(ROADMAP_FILE, 'utf-8');
    res.json({ content });
  } catch (err) {
    logger.error('Failed to read roadmap:', err.message);
    res.status(500).json({ error: 'Failed to read roadmap file' });
  }
});

app.get('/api/prompt', async (req, res) => {
  try {
    const content = await fs.readFile(PROMPT_FILE, 'utf-8');
    res.json({ content });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.json({ content: '# ROADMAP_PROMPT.md\n\n*File not yet generated. Run a task to generate this file.*' });
    } else {
      logger.error('Failed to read prompt:', err.message);
      res.status(500).json({ error: 'Failed to read prompt file' });
    }
  }
});

function extractTaskIdFromLog(filename) {
  const match = filename.match(/^task-([0-9]+\.[0-9]+)-/);
  return match ? match[1] : null;
}

app.get('/api/logs', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const now = Date.now();

    const runningAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(runningAgents);

    const taskToProcessMap = new Map();
    verifiedAgents.forEach(agent => {
      const taskMatch = agent.cmd.match(/task[_-]?([0-9]+\.[0-9]+)/i) ||
                       agent.args.match(/task[_-]?([0-9]+\.[0-9]+)/i);
      if (taskMatch) {
        taskToProcessMap.set(taskMatch[1], agent);
      }
    });

    const logFiles = files
      .filter(f => f.endsWith('.log') && validateFilename(f))
      .map(f => {
        const filepath = path.join(LOG_DIR, f);
        try {
          const stats = fsSync.statSync(filepath);
          const age = now - stats.mtime.getTime();
          const taskId = extractTaskIdFromLog(f);
          const associatedProcess = taskId ? taskToProcessMap.get(taskId) : null;

          const isActive = age < 600000;
          const isCurrentlyActive = age < 30000;

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
        if (a.isCurrentlyActive !== b.isCurrentlyActive) {
          return b.isCurrentlyActive - a.isCurrentlyActive;
        }
        if (a.isActive !== b.isActive) {
          return b.isActive - a.isActive;
        }
        return b.mtime - a.mtime;
      })
      .slice(0, 100);

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
    logger.error('Failed to list logs:', err.message);
    res.status(500).json({ error: 'Failed to list log files' });
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

app.get('/api/logs/latest', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files
      .filter(f => f.endsWith('.log') && validateFilename(f))
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
    logger.error('Failed to get latest log:', err.message);
    res.status(500).json({ error: 'Failed to get latest log file' });
  }
});

app.get('/api/logs/:filename', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    if (!filename) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filepath = path.join(LOG_DIR, filename);

    const realPath = await fs.realpath(filepath).catch(() => null);
    const realLogDir = await fs.realpath(LOG_DIR).catch(() => LOG_DIR);
    if (!realPath || !realPath.startsWith(realLogDir)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!fsSync.existsSync(filepath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }

    const stats = fsSync.statSync(filepath);
    const MAX_FILE_SIZE = 50 * 1024 * 1024;

    let content;
    let truncated = false;
    if (stats.size > MAX_FILE_SIZE) {
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
          cmd: sanitizeString(taskMatch.cmd, 200)
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
      res.status(500).json({ error: 'Failed to read log file' });
    }
  }
});

function invalidateProcessCache() {
  processCache.data = null;
  processCache.timestamp = 0;
}

app.post('/api/agent/start', async (req, res) => {
  if (agentProcess && !agentProcess.killed) {
    return res.status(400).json({ error: 'Agent is already running (managed by this dashboard)' });
  }

  invalidateProcessCache();

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
    const sanitizedTask = sanitizeString(task, 50).replace(/[^a-zA-Z0-9._-]/g, '');
    if (sanitizedTask) {
      args.push('--task', sanitizedTask);
      args.push('--single');
    }
  }
  if (!autoCommit) args.push('--no-commit');

  const sanitizedMaxLoops = parseInt(maxLoops, 10) || 0;
  const sanitizedLoopDelay = parseInt(loopDelay, 10) || 5;

  const env = {
    ...process.env,
    MAX_LOOPS: String(Math.max(0, Math.min(sanitizedMaxLoops, 1000))),
    LOOP_DELAY: String(Math.max(1, Math.min(sanitizedLoopDelay, 300))),
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
    if (agentProcess === currentProcess) {
      agentProcess = null;
    }
    invalidateProcessCache();
  });

  agentEvents.emit('start', { pid: agentProcess.pid });
  invalidateProcessCache();

  logger.info(`Agent started with PID ${agentProcess.pid}`);
  res.json({
    success: true,
    pid: agentProcess.pid,
    message: 'Agent started'
  });
});

app.post('/api/agent/stop', async (req, res) => {
  const { externalPid } = req.body;

  invalidateProcessCache();

  if (externalPid) {
    const validPid = validatePid(externalPid);
    if (!validPid) {
      return res.status(400).json({ error: 'Invalid PID format' });
    }

    try {
      await execAsync(`kill -0 ${validPid} 2>/dev/null`);

      const proc = await getProcessInfo(validPid);
      if (!proc || !isAgentProcess(proc)) {
        return res.status(400).json({ error: 'Process is not an agent process' });
      }

      if (proc.pgid) {
        try {
          await execAsync(`kill -TERM -${proc.pgid} 2>/dev/null || kill -TERM ${validPid}`);
        } catch (err) {
          await execAsync(`kill -TERM ${validPid}`);
        }
      } else {
        await execAsync(`pkill -TERM -P ${validPid} 2>/dev/null || true`);
        await execAsync(`kill -TERM ${validPid}`);
      }

      setTimeout(async () => {
        try {
          await execAsync(`kill -0 ${validPid} 2>/dev/null`);
          if (proc.pgid) {
            await execAsync(`kill -KILL -${proc.pgid} 2>/dev/null || kill -KILL ${validPid}`);
          } else {
            await execAsync(`pkill -KILL -P ${validPid} 2>/dev/null || true`);
            await execAsync(`kill -KILL ${validPid}`);
          }
        } catch (err) {
          // Process already dead
        }
        invalidateProcessCache();
      }, 5000);

      logger.info(`Stop signal sent to external agent PID ${validPid}`);
      invalidateProcessCache();
      return res.json({ success: true, message: `Stop signal sent to external agent (PID: ${validPid})` });
    } catch (err) {
      return res.status(404).json({ error: `Process ${validPid} not found or already stopped` });
    }
  }

  if (!agentProcess || agentProcess.killed) {
    return res.status(400).json({ error: 'No agent process managed by this dashboard' });
  }

  const processToKill = agentProcess;
  agentProcess.kill('SIGTERM');

  agentProcess = null;

  setTimeout(() => {
    if (processToKill && !processToKill.killed) {
      processToKill.kill('SIGKILL');
    }
    invalidateProcessCache();
  }, 5000);

  logger.info('Agent stop signal sent');
  invalidateProcessCache();
  res.json({ success: true, message: 'Agent stop signal sent' });
});

const logWatchers = new Map();

async function getActiveLogFiles(maxAge = 300000) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const now = Date.now();

    const runningAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(runningAgents);

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
      .filter(f => f.endsWith('.log') && validateFilename(f))
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
  const validFilename = validateFilename(filename);
  if (!validFilename) {
    return;
  }

  const filepath = path.join(LOG_DIR, validFilename);
  let position = 0;
  let retryCount = 0;
  const maxRetries = 10;
  const watchInterval = options.interval || 500;
  let watcher = null;
  let isClosed = false;
  let lastModified = 0;
  let checkCount = 0;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;

    if (watcher) {
      try {
        fsSync.unwatchFile(filepath, watcher);
      } catch (err) {
        logger.debug('Cleanup unwatch error (expected):', err.message);
      }
    }
    logWatchers.delete(res);
  };

  const sendContent = (content, isNew = false) => {
    if (isClosed || !content) return false;

    if (res.destroyed || !res.writable || res.closed) {
      cleanup();
      return false;
    }

    try {
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify({
        type: 'file',
        data: content,
        filename: validFilename,
        isNew
      })}\n\n`);
      retryCount = 0;
      return true;
    } catch (err) {
      logger.debug('Failed to send log content:', err.message);
      cleanup();
      return false;
    }
  };

  const readExisting = () => {
    try {
      if (fsSync.existsSync(filepath)) {
        const stats = fsSync.statSync(filepath);
        const MAX_INITIAL_SIZE = 10 * 1024 * 1024;

        let content;
        if (stats.size > MAX_INITIAL_SIZE) {
          const fd = fsSync.openSync(filepath, 'r');
          const buffer = Buffer.alloc(Math.min(MAX_INITIAL_SIZE, stats.size));
          const startPos = Math.max(0, stats.size - MAX_INITIAL_SIZE);
          fsSync.readSync(fd, buffer, 0, buffer.length, startPos);
          fsSync.closeSync(fd);
          content = buffer.toString('utf-8');
          position = stats.size;
          logger.debug(`Log file ${validFilename} is large (${(stats.size / 1024 / 1024).toFixed(2)}MB), reading tail only`);
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

  const startWatching = () => {
    if (isClosed) return;

    try {
      if (!fsSync.existsSync(filepath)) {
        if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(startWatching, 1000 * retryCount);
        } else {
          sendContent(`[Log file ${validFilename} not found yet]\n`, true);
        }
        return;
      }

      watcher = fsSync.watchFile(filepath, { interval: watchInterval }, (curr, prev) => {
        if (isClosed) return;

        try {
          checkCount++;

          if (curr.size > prev.size || (prev.size === 0 && curr.size > 0)) {
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
              sendContent(`[Log file rotated or truncated]\n`, true);
              position = 0;
              if (content) {
                sendContent(content, true);
                position = content.length;
                lastModified = curr.mtime.getTime();
              }
            }
          } else if (curr.size < prev.size) {
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
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.debug('Failed to read log file update:', err.message);
          }
          if (err.code === 'ENOENT' && retryCount < maxRetries) {
            retryCount++;
            setTimeout(() => {
              if (!isClosed) startWatching();
            }, 1000 * retryCount);
          }
        }
      });

      logWatchers.set(res, { watcher, filepath, filename: validFilename });
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

app.get('/api/stream', (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ error: 'Server shutting down' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  activeConnections.add(res);
  let isConnected = true;

  const isWritable = () => {
    return isConnected && !res.destroyed && res.writable && !res.closed && !isShuttingDown;
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

  (async () => {
    const allAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(allAgents);
    const externalPid = await getExternalAgentPid();
    const isRunning = agentProcess !== null && !agentProcess.killed;
    const hasExternal = externalPid !== null && (!isRunning || externalPid !== agentProcess.pid);

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
        .map(a => ({ pid: a.pid, cmd: sanitizeString(a.cmd, 200), comm: a.comm }))
    });

    if (hasExternal || isRunning) {
      try {
        if (!logWatchers.has(res)) {
          const activeFiles = await getActiveLogFiles(600000);
          const activeLogFiles = activeFiles.filter(f => f.isActive);

          if (activeLogFiles.length > 0) {
            const processAssociatedFiles = activeLogFiles.filter(f => f.associatedPid);
            const fileToWatch = processAssociatedFiles.length > 0
              ? processAssociatedFiles[0]
              : activeLogFiles[0];

            watchLogFile(fileToWatch.filename, res, req);

            sendEvent('log', {
              type: 'info',
              data: `[Watching log: ${fileToWatch.filename}${fileToWatch.taskId ? ` (Task ${fileToWatch.taskId})` : ''}${fileToWatch.associatedPid ? ` - PID ${fileToWatch.associatedPid}` : ''}]\n`
            });

            if (activeLogFiles.length > 1) {
              sendEvent('log', {
                type: 'info',
                data: `[${activeLogFiles.length - 1} other active log file(s) detected]\n`
              });
            }
          } else {
            const latestFiles = await getActiveLogFiles(3600000);
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

  const cleanup = () => {
    if (!isConnected) return;
    isConnected = false;

    activeConnections.delete(res);
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

app.get('/api/logs/:filename/stream', (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ error: 'Server shutting down' });
  }

  const filename = validateFilename(req.params.filename);
  if (!filename) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filepath = path.join(LOG_DIR, filename);

  if (!fsSync.existsSync(filepath)) {
    return res.status(404).json({ error: 'Log file not found' });
  }

  activeConnections.add(res);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  watchLogFile(filename, res, req);

  res.on('close', () => activeConnections.delete(res));
});

app.get('/api/logs/stats', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files.filter(f => f.endsWith('.log') && validateFilename(f));

    let totalLines = 0;
    let errorCount = 0;
    let warnCount = 0;
    let infoCount = 0;
    let successCount = 0;
    let totalSize = 0;
    const firstTimestamps = [];
    const lastTimestamps = [];

    for (const filename of logFiles) {
      const filepath = path.join(LOG_DIR, filename);
      try {
        const stats = fsSync.statSync(filepath);
        totalSize += stats.size;

        const content = await fs.readFile(filepath, 'utf-8');
        const lines = content.split('\n');
        totalLines += lines.length;

        lines.forEach(line => {
          if (/\b(error|exception|fatal|fail|✗|❌)\b/i.test(line)) {
            errorCount++;
          } else if (/\b(warn|warning|⚠)\b/i.test(line)) {
            warnCount++;
          } else if (/\b(info|→|ℹ)\b/i.test(line)) {
            infoCount++;
          } else if (/\b(success|✓|✅|completed)\b/i.test(line)) {
            successCount++;
          }
        });

        const timestampMatches = content.match(/\[(\d{2}:\d{2}:\d{2})\]/g);
        if (timestampMatches && timestampMatches.length > 0) {
          firstTimestamps.push(timestampMatches[0]);
          lastTimestamps.push(timestampMatches[timestampMatches.length - 1]);
        }
      } catch (err) {
        continue;
      }
    }

    const errorRate = totalLines > 0 ? errorCount / totalLines : 0;

    let linesPerSecond = 0;
    if (logFiles.length > 0) {
      const now = Date.now();
      const fileAges = [];
      for (const filename of logFiles) {
        const filepath = path.join(LOG_DIR, filename);
        try {
          const stats = fsSync.statSync(filepath);
          const ageSeconds = (now - stats.mtime.getTime()) / 1000;
          if (ageSeconds > 0) {
            fileAges.push(ageSeconds);
          }
        } catch (err) {
          continue;
        }
      }
      if (fileAges.length > 0) {
        const avgAge = fileAges.reduce((a, b) => a + b, 0) / fileAges.length;
        linesPerSecond = avgAge > 0 ? totalLines / avgAge : 0;
      }
    }

    res.json({
      totalLines,
      errorCount,
      warnCount,
      infoCount,
      successCount,
      errorRate,
      linesPerSecond,
      totalSize,
      fileCount: logFiles.length,
      firstTimestamp: firstTimestamps.length > 0 ? firstTimestamps.sort()[0] : null,
      lastTimestamp: lastTimestamps.length > 0 ? lastTimestamps.sort().reverse()[0] : null
    });
  } catch (err) {
    logger.error('Failed to get log stats:', err.message);
    res.status(500).json({ error: 'Failed to get log statistics' });
  }
});

app.get('/api/logs/timeline', async (req, res) => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files.filter(f => f.endsWith('.log') && validateFilename(f));

    const runningAgents = await findRunningAgents(true);
    const verifiedAgents = await verifyProcesses(runningAgents);

    const workerLogs = new Map();

    for (const filename of logFiles) {
      const filepath = path.join(LOG_DIR, filename);
      try {
        const content = await fs.readFile(filepath, 'utf-8');
        const lines = content.split('\n');

        let workerId = 'unknown';
        const taskMatch = filename.match(/task[_-]?([0-9]+\.[0-9]+)/i);
        if (taskMatch) {
          workerId = `task-${taskMatch[1]}`;
        } else {
          const matchingAgent = verifiedAgents.find(agent => {
            const agentTaskMatch = agent.cmd.match(/task[_-]?([0-9]+\.[0-9]+)/i) ||
                                   agent.args.match(/task[_-]?([0-9]+\.[0-9]+)/i);
            return agentTaskMatch && filename.includes(agentTaskMatch[1]);
          });
          if (matchingAgent) {
            workerId = `pid-${matchingAgent.pid}`;
          }
        }

        if (!workerLogs.has(workerId)) {
          workerLogs.set(workerId, []);
        }

        lines.forEach((line, idx) => {
          if (!line.trim()) return;

          const timestampMatch = line.match(/\[(\d{2}:\d{2}:\d{2})\]/);
          const timestamp = timestampMatch ? timestampMatch[1] : null;

          let level = 'stdout';
          if (/\b(error|exception|fatal|fail|✗)\b/i.test(line)) {
            level = 'error';
          } else if (/\b(warn|warning|⚠)\b/i.test(line)) {
            level = 'warn';
          } else if (/\b(info|→|ℹ)\b/i.test(line)) {
            level = 'info';
          } else if (/\b(success|✓|✅)\b/i.test(line)) {
            level = 'success';
          }

          workerLogs.get(workerId).push({
            timestamp,
            level,
            content: sanitizeString(line, 500),
            filename,
            lineNumber: idx + 1
          });
        });
      } catch (err) {
        continue;
      }
    }

    const workersData = {};
    workerLogs.forEach((logs, workerId) => {
      workersData[workerId] = {
        logs: logs.slice(0, 1000),
        stats: {
          total: logs.length,
          errors: logs.filter(l => l.level === 'error').length,
          warnings: logs.filter(l => l.level === 'warn').length
        }
      };
    });

    const allLogs = [];
    workerLogs.forEach((logs, workerId) => {
      logs.forEach(log => {
        allLogs.push({
          ...log,
          workerId
        });
      });
    });

    allLogs.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return a.timestamp.localeCompare(b.timestamp);
      }
      return 0;
    });

    res.json({
      workers: workersData,
      merged: allLogs.slice(0, 5000),
      totalWorkers: workerLogs.size,
      totalLogs: allLogs.length
    });
  } catch (err) {
    logger.error('Failed to get timeline:', err.message);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
});

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
          title: sanitizeString(taskMatch[2], 200),
          status: 'PENDING',
          priority: 'P9',
          dependencies: [],
          content: line
        };
      } else if (currentTask) {
        currentTask.content += '\n' + line;

        const statusMatch = line.match(/\*\*Status\*\*:\s*`([A-Z_]+)`/);
        if (statusMatch) {
          currentTask.status = statusMatch[1];
        }

        const priorityMatch = line.match(/\*\*Priority\*\*:\s*(P[0-9])/);
        if (priorityMatch) {
          currentTask.priority = priorityMatch[1];
        }

        if (line.includes('**Dependencies**:')) {
          const depMatch = line.match(/\*\*Dependencies\*\*:\s*(.+)/);
          if (depMatch) {
            const deps = depMatch[1].match(/[0-9]+\.[0-9]+/g) || [];
            currentTask.dependencies = deps;
          }
        }

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
    logger.error('Failed to get tasks:', err.message);
    res.status(500).json({ error: 'Failed to get tasks' });
  }
});

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

async function saveUserTasks(data) {
  await fs.writeFile(USER_TASKS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/user-tasks', async (req, res) => {
  try {
    const data = await loadUserTasks();
    res.json(data);
  } catch (err) {
    logger.error('Failed to load user tasks:', err.message);
    res.status(500).json({ error: 'Failed to load user tasks' });
  }
});

app.post('/api/user-tasks', async (req, res) => {
  try {
    const { title, description, priority, assignToAgent } = req.body;

    const sanitizedTitle = sanitizeString(title, 200);
    if (!sanitizedTitle) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const validPriorities = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'];
    const sanitizedPriority = validPriorities.includes(priority) ? priority : 'P5';

    const data = await loadUserTasks();
    const task = {
      id: `user-${data.nextId}`,
      title: sanitizedTitle,
      description: sanitizeString(description, 5000),
      priority: sanitizedPriority,
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

    if (assignToAgent) {
      task.agentPid = 'pending';
    }

    logger.info(`User task created: ${task.id}`);
    res.json({ task, success: true });
  } catch (err) {
    logger.error('Failed to create user task:', err.message);
    res.status(500).json({ error: 'Failed to create user task' });
  }
});

app.put('/api/user-tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!/^user-\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    const data = await loadUserTasks();
    const taskIndex = data.tasks.findIndex(t => t.id === id);

    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = data.tasks[taskIndex];

    if (updates.title !== undefined) task.title = sanitizeString(updates.title, 200);
    if (updates.description !== undefined) task.description = sanitizeString(updates.description, 5000);
    if (updates.priority !== undefined) {
      const validPriorities = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'];
      if (validPriorities.includes(updates.priority)) {
        task.priority = updates.priority;
      }
    }
    if (updates.status !== undefined) {
      const validStatuses = ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'];
      if (validStatuses.includes(updates.status)) {
        task.status = updates.status;
      }
    }
    if (updates.reviewStatus !== undefined) {
      const validReviewStatuses = ['approved', 'rejected', 'needs_revision', null];
      if (validReviewStatuses.includes(updates.reviewStatus)) {
        task.reviewStatus = updates.reviewStatus;
      }
    }
    if (updates.reviewNotes !== undefined) task.reviewNotes = sanitizeString(updates.reviewNotes, 2000);

    if (updates.assignToAgent === true && task.status !== 'ASSIGNED' && task.status !== 'IN_PROGRESS') {
      task.status = 'ASSIGNED';
      task.assignedAt = new Date().toISOString();
      task.agentPid = 'pending';
    }

    if (updates.status === 'COMPLETED' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    }

    task.updatedAt = new Date().toISOString();

    await saveUserTasks(data);
    logger.info(`User task updated: ${id}`);
    res.json({ task, success: true });
  } catch (err) {
    logger.error('Failed to update user task:', err.message);
    res.status(500).json({ error: 'Failed to update user task' });
  }
});

app.delete('/api/user-tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^user-\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    const data = await loadUserTasks();
    const taskIndex = data.tasks.findIndex(t => t.id === id);

    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    data.tasks.splice(taskIndex, 1);
    await saveUserTasks(data);

    logger.info(`User task deleted: ${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete user task:', err.message);
    res.status(500).json({ error: 'Failed to delete user task' });
  }
});

app.post('/api/user-tasks/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { taskId } = req.body;

    if (!/^user-\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

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
    task.roadmapTaskId = taskId ? sanitizeString(taskId, 20) : null;
    task.updatedAt = new Date().toISOString();

    await saveUserTasks(data);

    logger.info(`User task assigned: ${id}`);
    res.json({ task, success: true, message: 'Task assigned to agent' });
  } catch (err) {
    logger.error('Failed to assign user task:', err.message);
    res.status(500).json({ error: 'Failed to assign user task' });
  }
});

app.post('/api/user-tasks/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!/^user-\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    if (!status || !['approved', 'rejected', 'needs_revision'].includes(status)) {
      return res.status(400).json({ error: 'Invalid review status' });
    }

    const data = await loadUserTasks();
    const task = data.tasks.find(t => t.id === id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    task.reviewStatus = status;
    task.reviewNotes = sanitizeString(notes, 2000);
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

    logger.info(`User task reviewed: ${id} - ${status}`);
    res.json({ task, success: true });
  } catch (err) {
    logger.error('Failed to review user task:', err.message);
    res.status(500).json({ error: 'Failed to review user task' });
  }
});

app.post('/api/agent/user-tasks', async (req, res) => {
  try {
    const { title, description, priority, assignToAgent, sourceTaskId, sourceAgent } = req.body;

    const sanitizedTitle = sanitizeString(title, 200);
    if (!sanitizedTitle) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const validPriorities = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'];
    const sanitizedPriority = validPriorities.includes(priority) ? priority : 'P5';

    const data = await loadUserTasks();
    const task = {
      id: `user-${data.nextId}`,
      title: sanitizedTitle,
      description: sanitizeString(description, 5000),
      priority: sanitizedPriority,
      status: assignToAgent ? 'ASSIGNED' : 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignedAt: assignToAgent ? new Date().toISOString() : null,
      completedAt: null,
      agentPid: assignToAgent ? 'pending' : null,
      reviewStatus: null,
      reviewNotes: null,
      sourceTaskId: sourceTaskId ? sanitizeString(sourceTaskId, 50) : null,
      sourceAgent: sourceAgent ? sanitizeString(sourceAgent, 50) : 'roadmap-agent',
      createdBy: 'agent'
    };

    data.tasks.push(task);
    data.nextId++;
    await saveUserTasks(data);

    logger.info(`Agent created user task: ${task.id}`);
    res.json({ task, success: true });
  } catch (err) {
    logger.error('Failed to create agent user task:', err.message);
    res.status(500).json({ error: 'Failed to create user task' });
  }
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  for (const res of activeConnections) {
    try {
      res.end();
    } catch (err) {
      logger.debug('Error closing connection:', err.message);
    }
  }
  activeConnections.clear();

  for (const [res, { filepath, watcher }] of logWatchers.entries()) {
    try {
      fsSync.unwatchFile(filepath, watcher);
    } catch (err) {
      logger.debug('Error unwatching file:', err.message);
    }
  }
  logWatchers.clear();

  if (agentProcess && !agentProcess.killed) {
    logger.info('Stopping managed agent process...');
    agentProcess.kill('SIGTERM');
  }

  if (server) {
    server.close((err) => {
      if (err) {
        logger.error('Error closing server:', err.message);
        process.exit(1);
      }
      logger.info('Server closed successfully');
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn('Forceful shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message);
  logger.debug('Stack:', err.stack);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('Unhandled rejection:', message);
});

server = app.listen(PORT, HOST, () => {
  logger.info(`Server started on http://${HOST}:${PORT}`);
  logger.info(`Health check: http://${HOST}:${PORT}/api/health`);
});
