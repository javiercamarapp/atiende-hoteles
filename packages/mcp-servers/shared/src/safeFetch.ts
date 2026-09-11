/**
 * Cliente HTTP anti-SSRF para peticiones a una URL configurada por un tercero (NO fija
 * por proveedor) -- patrón hallado en la auditoría Likida/atiende.ai #1. A diferencia de
 * Stripe/Conekta/Cloudbeds/Meta/Resend/Google (cuyos adaptadores hablan SIEMPRE contra la
 * misma base fija del proveedor, nunca configurable por el hotel),
 * `packages/mcp-servers/outbound/src/adapters/webhook-outbound-adapter.ts` hace POST a
 * `destination.url`, un valor que CADA hotel de cadena configura libremente
 * (`hotel_pms_outbound_config.webhook_url`) -- un admin de hotel malicioso o comprometido
 * podría apuntarlo a un recurso interno (metadata de nube, servicio interno del propio
 * backend, loopback) y, con `fetch` nativo sin restricción de red, el servidor lo
 * consultaría igual. Este módulo es el ÚNICO punto de este repo donde un fetch de red
 * "a una URL no fija" debe pasar -- cualquier adaptador futuro con el mismo problema
 * (URL configurable por hotel/tenant) debe usar `safeFetch` en vez de `fetch` nativo.
 *
 * Defensas, en orden:
 *  1. Protocolo: solo `http:`/`https:` (nunca `file:`, `gopher:`, `data:`, ...).
 *  2. Resolución DNS explícita del hostname (`dns.lookup`, un único resultado) ANTES de
 *     abrir cualquier socket, seguida de validación de la IP resuelta contra los rangos
 *     privados/loopback/link-local/reservados de IPv4 e IPv6 (`isPrivateOrReservedIp`).
 *  3. Anti DNS-rebinding: la IP que se valida en el paso 2 es la MISMA que se usa para
 *     conectar el socket real -- se logra con la opción `lookup` de
 *     `http.request`/`https.request` (Node, documentada), que reemplaza la resolución DNS
 *     interna del propio request por un callback que ya trae la IP fijada de antemano, en
 *     vez de dejar que Node vuelva a resolver el hostname (posible respuesta DISTINTA de
 *     un DNS malicioso/comprometido entre el paso 2 y la conexión real -- el ataque
 *     clásico de "time-of-check to time-of-use" contra este tipo de guardas). El
 *     hostname original se preserva para el header `Host`/SNI TLS (`servername`), así que
 *     la verificación del certificado sigue siendo contra el dominio real.
 *  4. Redirects NUNCA se siguen automáticamente (`redirect: 'manual'` conceptual: por
 *     default `maxRedirects = 0`, la respuesta 3xx se devuelve tal cual). Si el llamador
 *     opta explícitamente por seguir redirects (`maxRedirects > 0`), CADA salto repite los
 *     pasos 1-3 completos contra la nueva URL (`Location`) -- nunca se asume que un
 *     destino ya validado sigue siendo seguro un salto después.
 *  5. Tope de bytes de la respuesta, aplicado EN STREAMING (se aborta la conexión en
 *     cuanto se excede, nunca se acumula el cuerpo completo en memoria antes de medirlo).
 *
 * No reemplaza `fetch()` en general -- expone el subconjunto que
 * `webhook-outbound-adapter.ts` necesita (`status`/`ok`/`headers.get`/`text()`), con las
 * mismas firmas de uso que la respuesta de `fetch` nativo para que el cambio en el
 * adaptador sea mínimo.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { type ClientRequest, type IncomingMessage, type RequestOptions, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000; // 1 MB -- suficiente para un ack JSON de webhook.
const DEFAULT_MAX_REDIRECTS = 0; // manual: nunca se sigue un redirect salvo opt-in explícito.

export class SsrfBlockedError extends Error {
  readonly code = "ssrf_blocked";
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`safeFetch bloqueó la petición a ${url}: ${reason}`);
    this.name = "SsrfBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

export class ResponseTooLargeError extends Error {
  readonly code = "response_too_large";
  readonly url: string;
  readonly limitBytes: number;

  constructor(url: string, limitBytes: number) {
    super(`safeFetch: la respuesta de ${url} excedió el límite de ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
    this.url = url;
    this.limitBytes = limitBytes;
  }
}

// --- Validación de IP privada/reservada -------------------------------------------------

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  return (
    (((Number(parts[0]) << 24) | (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3])) >>>
    0)
  );
}

function inIpv4Cidr(ipInt: number, base: string, prefixLen: number): boolean {
  const baseInt = ipv4ToInt(base);
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Rangos IPv4 bloqueados (IANA "Special-Purpose Address Registry"): loopback, RFC1918
// privadas, link-local (INCLUYE 169.254.169.254, el endpoint de metadata de nube de
// AWS/GCP/Azure -- el destino más buscado por un ataque SSRF real), CGNAT, multicast,
// reservado, broadcast, y los bloques de documentación/benchmarking (nunca deben
// resolver en producción, pero se bloquean igual por si acaso).
const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  return IPV4_BLOCKED_RANGES.some(([base, prefix]) => inIpv4Cidr(ipInt, base, prefix));
}

/** Primer hextet (16 bits) de una dirección IPv6 en forma canónica comprimida (la que
 *  devuelve `dns.lookup`) -- suficiente para los rangos que se validan abajo, todos
 *  alineados a un límite de hextet. `"::1"`/`"::"` empiezan con un grupo vacío (el
 *  primer hextet real es 0x0000). */
function firstIpv6Hextet(ip: string): number {
  const first = ip.split(":")[0];
  if (!first) return 0;
  const value = Number.parseInt(first, 16);
  return Number.isNaN(value) ? 0 : value;
}

export function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / no especificada
  // ::ffff:a.b.c.d (IPv4-mapeada): se desenvuelve y se valida con las reglas de IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateOrReservedIpv4(mapped[1]!);
  if (lower.startsWith("2001:db8")) return true; // documentación (2001:db8::/32)
  if (lower.startsWith("100:")) return true; // discard-only (100::/64)

  const hextet = firstIpv6Hextet(lower);
  if ((hextet & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((hextet & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((hextet & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** `true` si `ip` (literal IPv4 o IPv6) cae en un rango privado/loopback/link-local/
 *  reservado -- nunca debe usarse como destino de un fetch a una URL configurada por un
 *  tercero. Direcciones que `net.isIP` no reconoce (nunca deberían llegar aquí, `dns.
 *  lookup` siempre devuelve una IP válida) se tratan como bloqueadas por defecto
 *  (fail-closed: un formato inesperado nunca se interpreta como "seguro"). */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateOrReservedIpv4(ip);
  if (family === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

// --- safeFetch ----------------------------------------------------------------------

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Timeout total de la petición (conexión + respuesta) en ms. Default 10s. */
  timeoutMs?: number;
  /** Tope de bytes del cuerpo de respuesta, aplicado en streaming. Default 1 MB. */
  maxResponseBytes?: number;
  /** Saltos de redirect a seguir, cada uno re-validado desde cero (paso 1-3 del
   *  docstring de archivo). Default 0 -- nunca se sigue un redirect automáticamente. */
  maxRedirects?: number;
  /**
   * SOLO para pruebas: omite el rechazo de IP privada/reservada del paso 2 (el resto de
   * defensas -- protocolo, DNS-rebinding, redirects, tope de bytes -- siguen aplicando
   * igual). Sin esto, ninguna prueba de este repo podría ejercitar `safeFetch` de
   * extremo a extremo contra un servidor local real (siempre en 127.0.0.1, loopback).
   * NUNCA debe derivarse de una entrada controlada por un hotel/tenant -- solo código de
   * prueba (`*.spec.ts`) debe fijar `true` aquí, nunca una ruta de producción. Default
   * `false`.
   */
  allowPrivateIpForTesting?: boolean;
}

export interface SafeFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

function toHeadersGetter(raw: IncomingMessage["headers"]): SafeFetchResponse["headers"] {
  return {
    get(name: string): string | null {
      const value = raw[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? (value[0] ?? null) : value;
    },
  };
}

/** Resuelve `hostname` a UNA sola IP y la valida -- el único punto de resolución DNS
 *  real de todo el módulo (ver paso 2-3 del docstring de archivo: la MISMA IP que sale
 *  de aquí es la que se usa para conectar, nunca se vuelve a resolver). Literales IP
 *  (`"127.0.0.1"`, `"::1"`) pasan por `dns.lookup` sin producir tráfico DNS real -- Node
 *  las reconoce y las devuelve tal cual. */
async function resolveAndValidate(
  hostname: string,
  urlForError: string,
  allowPrivateIpForTesting: boolean,
): Promise<{ address: string; family: 4 | 6 }> {
  let resolved: { address: string; family: number };
  try {
    resolved = await dnsLookup(hostname, { family: 0 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SsrfBlockedError(urlForError, `no se pudo resolver el hostname "${hostname}": ${detail}`);
  }
  if (!allowPrivateIpForTesting && isPrivateOrReservedIp(resolved.address)) {
    throw new SsrfBlockedError(urlForError, `"${hostname}" resolvió a ${resolved.address}, una IP privada/reservada`);
  }
  return { address: resolved.address, family: resolved.family === 6 ? 6 : 4 };
}

/** Un único intento HTTP (sin seguir redirects) contra una IP ya validada, fijada vía la
 *  opción `lookup` (ver paso 3 del docstring de archivo). */
function performRequest(
  parsed: URL,
  pinnedAddress: string,
  pinnedFamily: 4 | 6,
  options: Required<Pick<SafeFetchOptions, "method" | "timeoutMs" | "maxResponseBytes">> & Pick<SafeFetchOptions, "headers" | "body">,
): Promise<SafeFetchResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === "https:";
    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const requestOptions: RequestOptions = {
      method: options.method,
      hostname: parsed.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: { host: parsed.host, ...options.headers },
      timeout: options.timeoutMs,
      // Fija la conexión a la IP ya validada -- ver paso 3 del docstring de archivo:
      // esto reemplaza la resolución DNS interna de Node por esta IP literal, sin
      // afectar `Host`/SNI (siguen viniendo de `hostname`/`host` arriba).
      lookup: (_hostname: string, _opts: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, pinnedAddress, pinnedFamily);
      },
    };

    const req: ClientRequest = (isHttps ? httpsRequest : httpRequest)(
      requestOptions,
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let tooLarge = false;

        res.on("data", (chunk: Buffer) => {
          if (tooLarge) return;
          totalBytes += chunk.length;
          if (totalBytes > options.maxResponseBytes) {
            tooLarge = true;
            res.destroy();
            req.destroy();
            finish(() => reject(new ResponseTooLargeError(parsed.toString(), options.maxResponseBytes)));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (tooLarge) return;
          finish(() =>
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: toHeadersGetter(res.headers),
              text: async () => Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
        res.on("error", (err) => finish(() => reject(err)));
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`safeFetch: timeout tras ${options.timeoutMs}ms`));
    });
    req.on("error", (err) => finish(() => reject(err)));

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Cliente HTTP anti-SSRF -- usar SIEMPRE en vez de `fetch()` nativo para cualquier URL
 * configurada por un hotel/tenant (nunca fija por proveedor). Ver docstring de archivo
 * para las 5 defensas aplicadas, en orden.
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = url;
  let redirectsLeft = maxRedirects;

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new SsrfBlockedError(currentUrl, "URL inválida");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SsrfBlockedError(currentUrl, `protocolo no permitido "${parsed.protocol}" (solo http:/https:)`);
    }

    const { address, family } = await resolveAndValidate(parsed.hostname, currentUrl, options.allowPrivateIpForTesting ?? false);
    const response = await performRequest(parsed, address, family, {
      method,
      timeoutMs,
      maxResponseBytes,
      headers: options.headers,
      body: options.body,
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect || redirectsLeft <= 0) {
      // Sin redirect, o presupuesto de saltos agotado (default 0: nunca se sigue) --
      // se devuelve la respuesta 3xx tal cual, el llamador decide (mismo comportamiento
      // que `fetch(url, { redirect: 'manual' })`).
      return response;
    }

    const location = response.headers.get("location");
    if (!location) return response; // 3xx sin Location: no hay a dónde seguir, se devuelve tal cual.

    redirectsLeft -= 1;
    // Cada salto se re-resuelve y re-valida desde cero en la siguiente vuelta del
    // bucle (paso 4 del docstring de archivo) -- nunca se asume que un destino ya
    // validado sigue siendo seguro un salto después.
    currentUrl = new URL(location, currentUrl).toString();
  }
}
