/**
 * How each tool the installer drives reports a network failure. One table, used both to pick the
 * "network" hint (errors.ts) and to decide when to wait for the connection and retry (network.ts).
 * Kept free of imports so both can use it without a cycle.
 */
export const NETWORK_ERROR_PATTERNS: readonly string[] = [
  // Node / undici (fetch). The code sits on the error's cause; errorText() includes it.
  '\\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\\b',
  'UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|CLOSED)',
  'fetch failed',
  // Electron net.fetch (Chromium).
  'net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\\w+|TIMED_OUT|NETWORK_\\w+|ADDRESS_UNREACHABLE|PROXY_\\w+|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|SSL_PROTOCOL_ERROR)',
  // Go programs: Docker, Docker Compose, Ollama.
  'no such host',
  'dial tcp',
  'i/o timeout',
  'TLS handshake timeout',
  'context deadline exceeded',
  'connection reset( by peer)?',
  'connection refused',
  'unexpected EOF',
  'network is unreachable',
  'no route to host',
  'server misbehaving',
  'net/http: request canceled',
  // curl, apt, dnf.
  'Could not resolve (host|proxy)',
  'Temporary failure (in name resolution|resolving)',
  'Failed to connect to',
  'Connection timed out',
  'Operation timed out',
  'curl: \\((6|7|28|35|52|56)\\)',
  'Curl error \\((6|7|28|35|52|56)\\)',
  'Cannot download repomd',
  // Windows: winget/WinINet HRESULTs and PowerShell / .NET.
  '0x80072ee[27]|0x80072efd|0x80072efe|0x80072f8f',
  'remote name could not be resolved',
  'Unable to connect to the remote server',
  'The operation has timed out',
  'underlying connection was closed',
  // Our own stall messages for downloads and model pulls.
  'No data received for',
  'No progress while pulling',
];

export const NETWORK_ERROR = new RegExp(NETWORK_ERROR_PATTERNS.join('|'), 'i');

/**
 * Failures talking to something on this computer (the Docker or Ollama daemon) look like network
 * errors ("connection refused") but waiting for the internet won't fix them.
 */
const LOCAL_ENDPOINT = /docker\.sock|docker_engine|dockerDesktopLinuxEngine|127\.0\.0\.1|localhost|\[::1\]/i;

/** Busy or broken servers: worth another try with a pause, not a wait for the connection. */
const SERVER_TRANSIENT = /toomanyrequests|too many requests|\bHTTP (408|429|5\d\d)\b|\b50[234]\b|Service Unavailable|Bad Gateway|Gateway Time-?out/i;

/** Answers that retrying won't change. */
const PERMANENT = /unauthorized|denied|manifest unknown|not found|signature/i;

/** A failure of the connection to the internet (not of a local daemon). */
export function isNetworkError(text: string): boolean {
  return NETWORK_ERROR.test(text) && !LOCAL_ENDPOINT.test(text);
}

/** A failure that another attempt may fix: network trouble or a busy server, never a refusal. */
export function isRetryableText(text: string): boolean {
  if (PERMANENT.test(text) && !NETWORK_ERROR.test(text)) return false;
  return isNetworkError(text) || SERVER_TRANSIENT.test(text);
}
