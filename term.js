const ANSI = {
  reset: '\x1b[0m',
  bold: '1',
  dim: '2',
  accent: '36',
  muted: '90',
  success: '32',
  warn: '33',
  error: '31',
};
const PANEL_WIDTH = 68;

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

function tone(text, toneName = 'muted', streamName = 'stdout') {
  if (toneName === 'accent') return accent(text, streamName);
  if (toneName === 'success') return success(text, streamName);
  if (toneName === 'warn') return warn(text, streamName);
  if (toneName === 'error') return error(text, streamName);
  if (toneName === 'bold') return wrap(text, 'bold', streamName);
  return muted(text, streamName);
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

function divider(labelText, streamName = 'stdout') {
  if (!labelText) return muted('  ' + '-'.repeat(PANEL_WIDTH), streamName);
  const label = ` ${labelText} `;
  const left = Math.max(2, Math.floor((PANEL_WIDTH - label.length) / 2));
  const right = Math.max(2, PANEL_WIDTH - label.length - left);
  return muted('  ' + '-'.repeat(left), streamName) +
    accent(label, streamName) +
    muted('-'.repeat(right), streamName);
}

function section(labelText, streamName = 'stdout') {
  return `  ${formatLabel(labelText, 'accent', streamName)}`;
}

function badge(labelText, toneName = 'muted', streamName = 'stdout') {
  return tone(`[${labelText}]`, toneName, streamName);
}

function kv(key, value, valueTone = null, streamName = 'stdout') {
  const keyText = String(key).toUpperCase().padEnd(9);
  const valueText = valueTone ? tone(String(value), valueTone, streamName) : String(value);
  return `  ${muted(keyText, streamName)} ${valueText}`;
}

function statusLine(labelText, message, toneName = 'accent', streamName = 'stdout') {
  return `  ${formatLabel(labelText, toneName, streamName)} ${message}`;
}

function progressBar(pct, width = 22, toneName = 'accent', streamName = 'stdout') {
  const cleanPct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round(cleanPct / 100 * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  return tone(`[${bar}]`, toneName, streamName);
}

function shortPath(filePath, maxLength = 46) {
  const value = String(filePath || '').replace(/\\/g, '/');
  if (value.length <= maxLength) return value;
  const parts = value.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const compact = `${parts[0]}/.../${parts[parts.length - 1]}`;
    if (compact.length <= maxLength) return compact;
  }
  return '...' + value.slice(-(maxLength - 3));
}

function banner(titleText, rows = [], options = {}) {
  const streamName = options.streamName || 'stdout';
  const subtitle = options.subtitle;
  const lines = [];
  lines.push('');
  lines.push(divider(null, streamName));
  lines.push(`  ${accent(String(titleText).toUpperCase(), streamName)}${subtitle ? ' ' + muted(subtitle, streamName) : ''}`);
  lines.push(divider(null, streamName));
  rows.forEach((row) => {
    if (!row) return;
    if (row.type === 'divider') {
      lines.push(divider(row.label, streamName));
    } else if (row.type === 'section') {
      lines.push(section(row.label, streamName));
    } else if (row.type === 'raw') {
      lines.push(`  ${row.value}`);
    } else {
      lines.push(kv(row.key, row.value, row.tone, streamName));
    }
  });
  lines.push(divider(null, streamName));
  lines.push('');
  lines.forEach((line) => writeLine(line, streamName));
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
  tone,
  formatLabel,
  formatMessage,
  write,
  writeLine,
  divider,
  section,
  badge,
  kv,
  statusLine,
  progressBar,
  shortPath,
  banner,
  logInfo,
  logSuccess,
  logWarn,
  logError,
};
