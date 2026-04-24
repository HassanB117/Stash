const ANSI = {
  reset: '\x1b[0m',
  bold: '1',
  accent: '36',
  muted: '90',
  success: '32',
  warn: '33',
  error: '31',
};

function resolveStream(streamName) {
  return streamName === 'stderr' ? process.stderr : process.stdout;
}

function colorsDisabled() {
  return Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR') || process.env.TERM === 'dumb';
}

function supportsColor(streamName = 'stdout') {
  const stream = resolveStream(streamName);
  return Boolean(stream && stream.isTTY) && !colorsDisabled();
}

function isInteractive(streamName = 'stdout') {
  const stream = resolveStream(streamName);
  return Boolean(stream && stream.isTTY);
}

function wrap(text, tones, streamName = 'stdout') {
  if (!supportsColor(streamName)) return text;
  const list = Array.isArray(tones) ? tones : [tones];
  const codes = list.map((tone) => ANSI[tone]).filter(Boolean);
  if (codes.length === 0) return text;
  return `\x1b[${codes.join(';')}m${text}${ANSI.reset}`;
}

function accent(text, streamName = 'stdout') {
  return wrap(text, ['bold', 'accent'], streamName);
}

function muted(text, streamName = 'stdout') {
  return wrap(text, 'muted', streamName);
}

function success(text, streamName = 'stdout') {
  return wrap(text, 'success', streamName);
}

function warn(text, streamName = 'stdout') {
  return wrap(text, 'warn', streamName);
}

function error(text, streamName = 'stdout') {
  return wrap(text, 'error', streamName);
}

function formatLabel(labelText, tone = 'muted', streamName = 'stdout') {
  return wrap(`[${labelText}]`, ['bold', tone], streamName);
}

function formatMessage(labelText, message, tone = 'muted', streamName = 'stdout') {
  return `  ${formatLabel(labelText, tone, streamName)} ${message}`;
}

function write(text, streamName = 'stdout') {
  resolveStream(streamName).write(text);
}

function writeLine(text = '', streamName = 'stdout') {
  write(text + '\n', streamName);
}

function logInfo(labelText, message) {
  writeLine(formatMessage(labelText, message, 'accent', 'stdout'), 'stdout');
}

function logSuccess(labelText, message) {
  writeLine(formatMessage(labelText, message, 'success', 'stdout'), 'stdout');
}

function logWarn(labelText, message) {
  writeLine(formatMessage(labelText, message, 'warn', 'stderr'), 'stderr');
}

function logError(labelText, message) {
  writeLine(formatMessage(labelText, message, 'error', 'stderr'), 'stderr');
}

module.exports = {
  supportsColor,
  isInteractive,
  wrap,
  accent,
  muted,
  success,
  warn,
  error,
  formatLabel,
  formatMessage,
  write,
  writeLine,
  logInfo,
  logSuccess,
  logWarn,
  logError,
};
