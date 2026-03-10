const fs = require("fs");
const path = require("path");

const RUNTIME_MODES = new Set(["auto", "process", "docker"]);
const DOCKER_ENABLED_VALUES = new Set(["auto", "on", "off"]);
const PYTHON_ENTRYPOINT_CANDIDATES = ["main.py", "app.py", "run.py"];

function toPosixPath(value = "") {
  return String(value).replace(/\\/g, "/");
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sanitizeDockerName(name = "app") {
  const cleaned = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || "app";
}

function defaultDockerImageTag(appName) {
  return `controlbot-${sanitizeDockerName(appName)}:latest`;
}

function defaultDockerContainerName(appName) {
  return `controlbot-${sanitizeDockerName(appName)}`;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeRuntimeMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "auto";
  return RUNTIME_MODES.has(mode) ? mode : "auto";
}

function normalizeDockerEnabled(value) {
  const enabled = typeof value === "string" ? value.trim().toLowerCase() : "auto";
  return DOCKER_ENABLED_VALUES.has(enabled) ? enabled : "auto";
}

function normalizeRuntime(runtime = {}) {
  return {
    status: runtime.status || "stopped",
    pid: runtime.pid || null,
    lastStartAt: runtime.lastStartAt || null,
    lastStopAt: runtime.lastStopAt || null,
    lastExitCode: runtime.lastExitCode ?? null,
    lastSignal: runtime.lastSignal || null,
    mode: normalizeRuntimeMode(runtime.mode)
  };
}

function normalizePythonConfig(python = {}) {
  return {
    detected: !!python.detected,
    venvEnabled: python.venvEnabled !== false,
    venvDir: typeof python.venvDir === "string" && python.venvDir.trim() ? python.venvDir.trim() : ".venv",
    entrypoint: typeof python.entrypoint === "string" && python.entrypoint.trim() ? python.entrypoint.trim() : null
  };
}

function normalizeDockerConfig(appName, docker = {}) {
  return {
    detected: !!docker.detected,
    enabled: normalizeDockerEnabled(docker.enabled),
    imageTag: typeof docker.imageTag === "string" && docker.imageTag.trim() ? docker.imageTag.trim() : defaultDockerImageTag(appName),
    containerName: typeof docker.containerName === "string" && docker.containerName.trim() ? docker.containerName.trim() : defaultDockerContainerName(appName),
    ports: normalizeStringArray(docker.ports),
    volumes: normalizeStringArray(docker.volumes),
    extraArgs: typeof docker.extraArgs === "string" ? docker.extraArgs.trim() : ""
  };
}

function normalizeAppRuntimeConfig(appName, app, deploymentsDir) {
  const base = app || {};
  const normalized = {
    ...base,
    runtime: normalizeRuntime(base.runtime || {}),
    python: normalizePythonConfig(base.python || {}),
    docker: normalizeDockerConfig(appName, base.docker || {})
  };

  if (deploymentsDir && !normalized.directory) {
    normalized.directory = path.join(deploymentsDir, appName);
  }

  return normalized;
}

function detectProjectProfile(appDirectory) {
  const result = {
    hasDockerfile: false,
    hasRequirements: false,
    hasPyproject: false,
    hasPythonFile: false,
    pythonDetected: false,
    entrypoint: null
  };

  if (!appDirectory || !fs.existsSync(appDirectory)) {
    return result;
  }

  result.hasDockerfile = fs.existsSync(path.join(appDirectory, "Dockerfile"));
  result.hasRequirements = fs.existsSync(path.join(appDirectory, "requirements.txt"));
  result.hasPyproject = fs.existsSync(path.join(appDirectory, "pyproject.toml"));

  for (const candidate of PYTHON_ENTRYPOINT_CANDIDATES) {
    if (fs.existsSync(path.join(appDirectory, candidate))) {
      result.entrypoint = candidate;
      break;
    }
  }

  try {
    const rootEntries = fs.readdirSync(appDirectory, { withFileTypes: true });
    result.hasPythonFile = rootEntries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".py"));
  } catch {
    result.hasPythonFile = false;
  }

  result.pythonDetected = !!(result.entrypoint || result.hasRequirements || result.hasPyproject || result.hasPythonFile);
  return result;
}

function resolveRuntimeMode(app) {
  const dockerEnabled = normalizeDockerEnabled(app && app.docker ? app.docker.enabled : "auto");
  if (dockerEnabled === "on") return "docker";
  if (dockerEnabled === "off") return "process";
  return app && app.docker && app.docker.detected ? "docker" : "process";
}

function pythonExecutable(app) {
  const venvDir = app && app.python && app.python.venvDir ? app.python.venvDir : ".venv";
  return `${toPosixPath(venvDir)}/bin/python`;
}

function pipExecutable(app) {
  const venvDir = app && app.python && app.python.venvDir ? app.python.venvDir : ".venv";
  return `${toPosixPath(venvDir)}/bin/pip`;
}

function buildPythonInstallCommand(app, profile) {
  const pythonExec = pythonExecutable(app);
  if (profile && profile.hasRequirements) {
    return `${shellQuote(pythonExec)} -m pip install -r requirements.txt`;
  }
  if (profile && profile.hasPyproject) {
    return `${shellQuote(pythonExec)} -m pip install .`;
  }
  return "";
}

function buildPythonStartCommand(app, entrypoint) {
  if (!entrypoint) return "";
  const pythonExec = pythonExecutable(app);
  return `${shellQuote(pythonExec)} ${shellQuote(toPosixPath(entrypoint))}`;
}

function parseListInput(text = "") {
  return String(text)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dockerEnvArgs(envObject = {}) {
  const pairs = [];
  for (const [key, value] of Object.entries(envObject || {})) {
    if (!key || typeof key !== "string") continue;
    pairs.push(`--env ${shellQuote(`${key}=${value}`)}`);
  }
  return pairs;
}

module.exports = {
  defaultDockerImageTag,
  defaultDockerContainerName,
  normalizeRuntimeMode,
  normalizeDockerEnabled,
  normalizeRuntime,
  normalizePythonConfig,
  normalizeDockerConfig,
  normalizeAppRuntimeConfig,
  detectProjectProfile,
  resolveRuntimeMode,
  pythonExecutable,
  pipExecutable,
  buildPythonInstallCommand,
  buildPythonStartCommand,
  shellQuote,
  toPosixPath,
  parseListInput,
  dockerEnvArgs
};
