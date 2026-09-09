#!/usr/bin/env node
// fix/voz-elevenlabs · Simulador local del contrato de "Server Tool" (webhook) de
// ElevenLabs Conversational AI contra un servidor REAL de este repo corriendo en
// local (`npm run dev --workspace=@atiende-hoteles/api`, con seed de desarrollo).
//
// HONESTIDAD (ADR-006/007, ver docs/agente-voz/webhook-contrato.md): este script NO
// contacta a ElevenLabs -- no hay cuenta real conectada en este entorno. Lo único que
// simula es "cómo se ve, del lado de ElevenLabs, una llamada de tool real" contra
// NUESTRO propio endpoint, que sí es 100% real (el código que lo atiende es exactamente
// el que atendería una llamada telefónica real). Prueba las DOS formas de cuerpo que la
// documentación deja ambiguas (ver comentario de `extractToolParams` en
// apps/api/src/routes/vozElevenlabs.ts) para demostrar que el webhook las acepta a
// ambas -- eso NO es lo mismo que haber confirmado cuál de las dos usa ElevenLabs de
// verdad hoy.
//
// Uso:
//   npm run dev --workspace=@atiende-hoteles/api    # en otra terminal, deja corriendo
//   node --experimental-strip-types scripts/voz-elevenlabs-webhook-simulator.ts \
//     [--base-url=http://localhost:3001] [--activar-propone]
//
// Sin `--activar-propone`, el hotel queda con el gate que ya tenía (shadow por
// default, BP-016) -- el simulador solo ACTIVA el canal (`enabled=true`), nunca cambia
// el gate por su cuenta salvo que se pida explícitamente, para no alterar en silencio
// el comportamiento de un hotel real si este script se corriera por error contra un
// ambiente que no es puramente de desarrollo.
import { DEV_SEED_PASSWORD } from "@atiende-hoteles/db";

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? "http://localhost:3001").replace(/\/+$/, "");
const activarPropone = args.includes("--activar-propone");

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`respuesta no-JSON de ${res.url} (status ${res.status}): ${text.slice(0, 300)}`);
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login falló para ${email}: ${res.status} ${await res.text()}`);
  const body = await json<{ token: string }>(res);
  return body.token;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function main() {
  console.log(`[simulador] apuntando a ${baseUrl} (debe ser tu servidor de desarrollo REAL, npm run dev)`);

  const ownerEmail = "owner@hotel-demo-centro.demo";
  console.log(`[simulador] iniciando sesión como ${ownerEmail} (seed de desarrollo, DEV_SEED_PASSWORD)...`);
  const ownerToken = await login(ownerEmail);

  const hotelesRes = await fetch(`${baseUrl}/hoteles`, { headers: auth(ownerToken) });
  const hoteles = await json<Array<{ id: string; nombre: string }>>(hotelesRes);
  const hotel = hoteles[0];
  if (!hotel) throw new Error("no se encontró ningún hotel para este usuario -- ¿corriste el seed de desarrollo?");
  console.log(`[simulador] hotel: ${hotel.nombre} (${hotel.id})`);

  await fetch(`${baseUrl}/hoteles/${hotel.id}/voz/config`, {
    method: "PATCH",
    headers: auth(ownerToken),
    body: JSON.stringify({ habilitado: true, elevenlabsAgentId: "agent_simulador_local" }),
  });
  if (activarPropone) {
    console.log('[simulador] --activar-propone: fijando gate de "recepcion_virtual" a "propone" para este hotel...');
    await fetch(`${baseUrl}/hoteles/${hotel.id}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "propone" }),
    });
  }

  const cfgRes = await fetch(`${baseUrl}/hoteles/${hotel.id}/voz/config`, { headers: auth(ownerToken) });
  const cfg = await json<{ toolWebhookSecret: string; gateRecepcionVirtual: string; urlsWebhook: Record<string, string> }>(cfgRes);
  console.log(`[simulador] gate actual de recepcion_virtual: ${cfg.gateRecepcionVirtual}`);

  const roomRes = await fetch(`${baseUrl}/hoteles/${hotel.id}/housekeeping/tablero`, { headers: auth(ownerToken) });
  const rooms = await json<Array<{ roomCode: string }>>(roomRes);
  const roomCode = rooms[0]?.roomCode;
  if (!roomCode) throw new Error("el hotel no tiene habitaciones sembradas");

  async function llamarTool(toolName: string, body: Record<string, unknown>, envolverComoElevenLabs: boolean) {
    // Dos formas de cuerpo (ver comentario de archivo): "plana" (patrón real
    // confirmado de atiende-restaurantes) y "envuelta" en {tool_call_id, tool_name,
    // parameters, conversation_id} (formato genérico documentado por la skill
    // empaquetada "agents"). El webhook real acepta ambas -- se ejercitan las dos aquí
    // a propósito, alternando, para demostrarlo.
    const wireBody = envolverComoElevenLabs
      ? { tool_call_id: `sim_${Date.now()}`, tool_name: toolName, parameters: body, conversation_id: `conv_sim_${Date.now()}` }
      : body;
    const res = await fetch(`${baseUrl}${cfg.urlsWebhook[toolName]}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atiende-voz-tool-secret": cfg.toolWebhookSecret },
      body: JSON.stringify(wireBody),
    });
    const text = await res.text();
    console.log(`\n[simulador] POST ${cfg.urlsWebhook[toolName]} (cuerpo ${envolverComoElevenLabs ? "envuelto" : "plano"})`);
    console.log(`  status ${res.status}`);
    console.log(`  body   ${text}`);
    return res.status;
  }

  await llamarTool("crear-tarea-housekeeping", { roomCode, priority: "alta", notes: "Huésped reportó ruido por teléfono (simulado)" }, false);
  await llamarTool(
    "crear-ticket-mantenimiento",
    { roomCode, title: "AC no enfría (simulado)", description: "El huésped reporta por voz que el aire acondicionado no enfría.", severity: "media" },
    true,
  );
  await llamarTool(
    "registrar-evento-roi",
    {
      tipoEvento: "checkin_asistido_por_voz",
      montoEstimado: 5,
      metodoContrafactual: "Minutos de recepción ahorrados al resolver la incidencia por voz (simulado).",
      confianza: 0.5,
    },
    false,
  );
  await llamarTool(
    "enviar-whatsapp-plantilla",
    { guestPhone: "+5215500001234", templateName: "checkin_confirmado", parameters: ["Huésped simulado"] },
    true,
  );

  console.log(
    "\n[simulador] listo. Recuerda: esto NUNCA se ha ejercitado contra una llamada telefónica real ni contra la " +
      "API real de ElevenLabs -- ver docs/agente-voz/runbook-pasos-manuales.md para los pasos manuales pendientes.",
  );
}

main().catch((err) => {
  console.error("[simulador] error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
