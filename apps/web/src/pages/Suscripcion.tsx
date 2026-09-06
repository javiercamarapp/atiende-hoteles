// H12c · LAUNCH-015: estado de la suscripción SaaS del hotel, límites usados y CTA de
// upgrade/portal. Los precios de plan son PROPUESTA (H18), pendientes de aprobación del
// fundador (docs/BLOQUEOS.md D-006) -- se muestran con la insignia correspondiente,
// nunca como precio de lista definitivo.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CreditCard, ExternalLink } from "lucide-react";
import { Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, EstadoError, Separator } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { useHotel } from "../hooks/useHotel";
import { obtenerSuscripcion, listarPlanes, listarFacturasSaas, crearCheckoutSuscripcion, crearPortalSuscripcion, type Plan } from "../lib/api";
import { track } from "../lib/analytics";

function formatoMxn(centavos: number | null): string {
  if (centavos == null) return "Cotización directa";
  return `$${(centavos / 100).toLocaleString("es-MX", { minimumFractionDigits: 0 })} MXN`;
}

function BarraUso({ etiqueta, usado, limite }: { etiqueta: string; usado: number; limite: number | null }) {
  const pct = limite ? Math.min(100, Math.round((usado / limite) * 100)) : 0;
  const cerca = limite != null && usado / limite >= 0.8;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-muted-foreground">{etiqueta}</span>
        <span className={cerca ? "font-medium text-destructive" : "font-medium"}>
          {usado} {limite != null ? `/ ${limite}` : "(sin límite)"}
        </span>
      </div>
      {limite != null && (
        <div className="h-2 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full ${cerca ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function Suscripcion() {
  const { hotelActivoId } = useHotel();
  const queryClient = useQueryClient();
  const [cargandoAccion, setCargandoAccion] = useState<string | null>(null);

  const subQuery = useQuery({
    queryKey: ["suscripcion", hotelActivoId],
    queryFn: () => obtenerSuscripcion(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });
  const planesQuery = useQuery({ queryKey: ["planes"], queryFn: () => listarPlanes(), retry: false });
  const facturasQuery = useQuery({
    queryKey: ["facturas-saas", hotelActivoId],
    queryFn: () => listarFacturasSaas(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  if (subQuery.isError) {
    return (
      <div>
        <PageHeader titulo="Suscripción" descripcion="Estado de tu plan, límites de uso y facturación." />
        <EstadoError titulo="Sin conexión con el API" mensaje="No se pudo cargar el estado de tu suscripción." onReintentar={() => subQuery.refetch()} />
      </div>
    );
  }

  const sub = subQuery.data;

  async function mejorarPlan(plan: Plan) {
    if (!hotelActivoId) return;
    setCargandoAccion(plan.codigo);
    track("subscription_upgrade_clicked", { plan: plan.codigo });
    try {
      const { checkoutUrl } = await crearCheckoutSuscripcion(hotelActivoId, {
        planCode: plan.codigo,
        successUrl: `${window.location.origin}/suscripcion?checkout=exito`,
        cancelUrl: `${window.location.origin}/suscripcion?checkout=cancelado`,
      });
      track("subscription_checkout_started", { plan: plan.codigo });
      window.location.href = checkoutUrl;
    } finally {
      setCargandoAccion(null);
      await queryClient.invalidateQueries({ queryKey: ["suscripcion", hotelActivoId] });
    }
  }

  async function abrirPortal() {
    if (!hotelActivoId) return;
    setCargandoAccion("portal");
    try {
      const { portalUrl } = await crearPortalSuscripcion(hotelActivoId, { returnUrl: window.location.href });
      track("subscription_portal_opened");
      window.location.href = portalUrl;
    } finally {
      setCargandoAccion(null);
    }
  }

  return (
    <div>
      <PageHeader titulo="Suscripción" descripcion="Estado de tu plan, límites de uso y facturación del servicio." />

      {!sub ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">
              Esta organización todavía no tiene una suscripción activa. Elige un plan abajo para comenzar tu prueba de 14 días.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                Plan {sub.plan?.nombre ?? "—"}
                <Badge variant={sub.estado === "activa" ? "default" : sub.estado === "trial" ? "secondary" : "destructive"}>
                  {sub.estado}
                </Badge>
              </CardTitle>
              <CardDescription>
                {sub.estado === "trial"
                  ? `Prueba gratuita hasta el ${new Date(sub.trialTermina).toLocaleDateString("es-MX")}.`
                  : `Periodo actual: ${new Date(sub.periodoInicio).toLocaleDateString("es-MX")} — ${new Date(sub.periodoFin).toLocaleDateString("es-MX")}.`}
              </CardDescription>
            </div>
            <Button variant="outline" onClick={abrirPortal} disabled={cargandoAccion === "portal"}>
              <CreditCard className="size-4 mr-1.5" aria-hidden="true" /> Portal de facturación
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <BarraUso etiqueta="Hoteles" usado={sub.uso.hoteles} limite={sub.plan?.limites.hoteles ?? null} />
            <BarraUso etiqueta="Habitaciones" usado={sub.uso.habitaciones} limite={sub.plan?.limites.habitaciones ?? null} />
            <BarraUso etiqueta="Agentes activos" usado={sub.uso.agentesActivos} limite={sub.plan?.limites.agentesActivos ?? null} />
            <BarraUso etiqueta="Mensajes este mes" usado={sub.uso.mensajesMes} limite={sub.plan?.limites.mensajesMes ?? null} />
          </CardContent>
        </Card>
      )}

      <h2 className="font-display text-lg font-semibold mb-2 mt-6">Planes</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Precios propuestos según benchmarks de mercado (H18) — <strong>pendientes de aprobación del fundador</strong>, no son un precio de
        lista definitivo.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(planesQuery.data ?? []).map((plan) => (
          <Card key={plan.id} className={sub?.plan?.codigo === plan.codigo ? "border-primary" : undefined}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                {plan.nombre}
                {plan.esPropuesta && (
                  <Badge variant="outline" className="text-[10px]">
                    propuesta
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {formatoMxn(plan.precioMxnCentavos)}
                {plan.precioMxnCentavos != null ? ` / ${plan.ciclo}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <ul className="text-sm text-muted-foreground space-y-1">
                <li className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
                  {plan.limites.hoteles ?? "Ilimitados"} hotel(es)
                </li>
                <li className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
                  {plan.limites.habitaciones ?? "Ilimitadas"} habitaciones
                </li>
                <li className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
                  {plan.limites.agentesActivos ?? "Ilimitados"} agentes activos
                </li>
                <li className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
                  {plan.limites.mensajesMes ?? "Ilimitados"} mensajes/mes
                </li>
              </ul>
              <Button
                className="w-full mt-2"
                disabled={sub?.plan?.codigo === plan.codigo || cargandoAccion === plan.codigo}
                onClick={() => mejorarPlan(plan)}
              >
                {sub?.plan?.codigo === plan.codigo ? "Plan actual" : plan.precioMxnCentavos == null ? "Contactar ventas" : "Elegir plan"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="font-display text-lg font-semibold mb-2 mt-6">Facturas</h2>
      {(facturasQuery.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin facturas todavía.</p>
      ) : (
        <div className="space-y-2">
          {facturasQuery.data!.map((f) => (
            <Card key={f.id}>
              <CardContent className="py-3 flex items-center justify-between text-sm">
                <span>
                  {new Date(f.periodoInicio).toLocaleDateString("es-MX")} — {new Date(f.periodoFin).toLocaleDateString("es-MX")}
                </span>
                <span className="font-medium">{formatoMxn(f.montoMxnCentavos)}</span>
                <Badge variant={f.estado === "pagada" ? "default" : "secondary"}>{f.estado}</Badge>
                {f.cfdiUuid ? (
                  <a className="text-primary underline underline-offset-2 flex items-center gap-1" href={f.cfdiUuid}>
                    CFDI <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">CFDI pendiente de PAC real</span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Separator className="my-6" />
      <p className="text-xs text-muted-foreground">
        Facturación procesada por un proveedor simulado mientras no haya credenciales de Stripe/Conekta conectadas (ver README de
        packages/mcp-servers/billing). Ningún cargo real se realiza en este entorno.
      </p>
    </div>
  );
}
