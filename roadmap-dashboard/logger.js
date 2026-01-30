// Simple structured logger for roadmap-dashboard

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const LOG_LEVEL_NAMES = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
const currentLevel = process.env.LOG_LEVEL === 'debug' ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message) {
  const timestamp = formatTimestamp();
  const levelName = LOG_LEVEL_NAMES[level];
  return `[${timestamp}] [${levelName}] ${message}`;
}

const logger = {
  error: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.ERROR) {
      console.error(formatMessage(LOG_LEVELS.ERROR, message), ...args);
    }
  },
  
  warn: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.WARN) {
      console.warn(formatMessage(LOG_LEVELS.WARN, message), ...args);
    }
  },
  
  info: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.INFO) {
      console.log(formatMessage(LOG_LEVELS.INFO, message), ...args);
    }
  },
  
  debug: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.DEBUG) {
      console.log(formatMessage(LOG_LEVELS.DEBUG, message), ...args);
    }
  }
};

module.exports = logger;
