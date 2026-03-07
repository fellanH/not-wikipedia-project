const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const LOG_LEVEL_NAMES = ["ERROR", "WARN", "INFO", "DEBUG"];
const currentLevel =
  LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;
const useJson =
  process.env.LOG_FORMAT === "json" || process.env.NODE_ENV === "production";

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, meta = {}) {
  const timestamp = formatTimestamp();
  const levelName = LOG_LEVEL_NAMES[level];

  if (useJson) {
    const logObj = {
      timestamp,
      level: levelName,
      message,
      pid: process.pid,
      ...meta,
    };
    return JSON.stringify(logObj);
  }

  return `[${timestamp}] [${levelName}] ${message}`;
}

function extractMeta(args) {
  if (args.length === 0) return { meta: {}, rest: [] };

  const last = args[args.length - 1];
  if (
    last &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    !(last instanceof Error)
  ) {
    return { meta: last, rest: args.slice(0, -1) };
  }

  return { meta: {}, rest: args };
}

const logger = {
  error: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.ERROR) {
      const { meta, rest } = extractMeta(args);
      if (rest.length > 0 && rest[0] instanceof Error) {
        meta.error = { message: rest[0].message, stack: rest[0].stack };
        rest.shift();
      }
      console.error(formatMessage(LOG_LEVELS.ERROR, message, meta), ...rest);
    }
  },

  warn: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.WARN) {
      const { meta, rest } = extractMeta(args);
      console.warn(formatMessage(LOG_LEVELS.WARN, message, meta), ...rest);
    }
  },

  info: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.INFO) {
      const { meta, rest } = extractMeta(args);
      console.log(formatMessage(LOG_LEVELS.INFO, message, meta), ...rest);
    }
  },

  debug: (message, ...args) => {
    if (currentLevel >= LOG_LEVELS.DEBUG) {
      const { meta, rest } = extractMeta(args);
      console.log(formatMessage(LOG_LEVELS.DEBUG, message, meta), ...rest);
    }
  },
};

module.exports = logger;
