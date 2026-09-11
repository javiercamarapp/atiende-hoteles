// Patrón Likida/atiende.ai #1 (anti-SSRF): `safeFetch` es el único cliente HTTP de este
// repo permitido para una URL configurada por un tercero (no fija por proveedor). Este
// archivo prueba (a) la clasificación de IP privada/reservada en puro (sin red, IPv4 e
// IPv6), y (b) el comportamiento real contra un servidor HTTP local (`node:http`) --
// bloqueo por defecto, tope de bytes en streaming, y redirect nunca seguido por default.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPrivateOrReservedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  ResponseTooLargeError,
  safeFetch,
  SsrfBlockedError,
} from "@atiende-hoteles/mcp-shared";

describe("isPrivateOrReservedIpv4", () => {
  it("marca loopback (127.0.0.0/8)", () => {
    expect(isPrivateOrReservedIpv4("127.0.0.1")).toBe(true);
  });

  it("marca las 3 redes RFC1918 completas", () => {
    expect(isPrivateOrReservedIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIpv4("192.168.1.1")).toBe(true);
  });

  it("marca link-local (169.254.0.0/16), incluido el endpoint de metadata de nube 169.254.169.254", () => {
    expect(isPrivateOrReservedIpv4("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIpv4("169.254.0.1")).toBe(true);
  });

  it("marca CGNAT (100.64.0.0/10)", () => {
    expect(isPrivateOrReservedIpv4("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("100.127.255.255")).toBe(true);
  });

  it("marca 0.0.0.0/8, multicast, reservado y broadcast", () => {
    expect(isPrivateOrReservedIpv4("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedIpv4("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("240.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpv4("255.255.255.255")).toBe(true);
  });

  it("NO marca una IP pública real (ej. 8.8.8.8, 1.1.1.1)", () => {
    expect(isPrivateOrReservedIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIpv4("1.1.1.1")).toBe(false);
  });

  it("el límite de 172.16.0.0/12 no se pasa de largo (172.32.0.1 es pública)", () => {
    expect(isPrivateOrReservedIpv4("172.32.0.1")).toBe(false);
  });
});

describe("isPrivateOrReservedIpv6", () => {
  it("marca loopback (::1) y no-especificada (::)", () => {
    expect(isPrivateOrReservedIpv6("::1")).toBe(true);
    expect(isPrivateOrReservedIpv6("::")).toBe(true);
  });

  it("marca unique-local (fc00::/7) y link-local (fe80::/10)", () => {
    expect(isPrivateOrReservedIpv6("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateOrReservedIpv6("fe80::1")).toBe(true);
  });

  it("marca multicast (ff00::/8)", () => {
    expect(isPrivateOrReservedIpv6("ff02::1")).toBe(true);
  });

  it("desenvuelve una IPv4-mapeada (::ffff:169.254.169.254) y aplica las reglas de IPv4", () => {
    expect(isPrivateOrReservedIpv6("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIpv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("NO marca una IPv6 pública real (2001:4860:4860::8888, DNS público de Google)", () => {
    expect(isPrivateOrReservedIpv6("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isPrivateOrReservedIp (dispatcher)", () => {
  it("distingue familia automáticamente", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
  });
});

describe("safeFetch: comportamiento real contra un servidor HTTP local", () => {
  let server: Server | null = null;
  let baseUrl = "";

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    return baseUrl;
  }

  it("por default (sin allowPrivateIpForTesting), bloquea una URL que resuelve a loopback -- NUNCA abre el socket", async () => {
    let hit = false;
    const url = await startServer((_req, res) => {
      hit = true;
      res.writeHead(200);
      res.end("no debería llegar aquí");
    });
    await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(hit).toBe(false);
  });

  it("con allowPrivateIpForTesting=true, entrega un GET real y expone status/headers/text()", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(201, { "content-type": "application/json", "x-custom": "abc" });
      res.end(JSON.stringify({ ok: true }));
    });
    const res = await safeFetch(url, { allowPrivateIpForTesting: true });
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers.get("x-custom")).toBe("abc");
    expect(res.headers.get("X-CUSTOM")).toBe("abc"); // case-insensitive, como fetch nativo.
    expect(await res.text()).toBe(JSON.stringify({ ok: true }));
  });

  it("un status >=300 <400 se devuelve tal cual por default (nunca se sigue automáticamente, redirect 'manual')", async () => {
    const url = await startServer((req, res) => {
      if (req.url === "/inicio") {
        res.writeHead(302, { location: "/destino" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("destino real");
    });
    const res = await safeFetch(`${url}/inicio`, { allowPrivateIpForTesting: true });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/destino");
  });

  it("con maxRedirects>0, sigue el redirect y re-valida el destino (aquí también local, con la misma bandera de prueba)", async () => {
    const url = await startServer((req, res) => {
      if (req.url === "/inicio") {
        res.writeHead(302, { location: "/destino" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("destino real");
    });
    const res = await safeFetch(`${url}/inicio`, { allowPrivateIpForTesting: true, maxRedirects: 1 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("destino real");
  });

  it("un cuerpo de respuesta que excede maxResponseBytes aborta con ResponseTooLargeError (streaming, no espera a terminar de descargar)", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // Escribe en chunks para forzar que el límite se detecte a mitad de la descarga.
      const chunk = "x".repeat(1000);
      let written = 0;
      const interval = setInterval(() => {
        if (res.writableEnded) return clearInterval(interval);
        res.write(chunk);
        written += chunk.length;
        if (written > 5000) {
          clearInterval(interval);
          res.end();
        }
      }, 5);
    });
    await expect(safeFetch(url, { allowPrivateIpForTesting: true, maxResponseBytes: 2000 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("rechaza un protocolo distinto de http:/https: (ej. file:)", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("un hostname que no resuelve produce SsrfBlockedError (nunca cuelga silenciosamente)", async () => {
    await expect(safeFetch("http://este-host-no-existe-en-ningun-dns.invalid")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("propaga method/headers/body al servidor real", async () => {
    let receivedMethod = "";
    let receivedBody = "";
    let receivedHeader = "";
    const url = await startServer((req, res) => {
      receivedMethod = req.method ?? "";
      receivedHeader = req.headers["x-test"] as string;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200);
        res.end("ok");
      });
    });
    await safeFetch(url, {
      allowPrivateIpForTesting: true,
      method: "POST",
      headers: { "x-test": "valor" },
      body: "cuerpo-de-prueba",
    });
    expect(receivedMethod).toBe("POST");
    expect(receivedHeader).toBe("valor");
    expect(receivedBody).toBe("cuerpo-de-prueba");
  });
});
