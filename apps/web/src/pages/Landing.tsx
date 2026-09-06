// H12c · LAUNCH-025: landing pública de promoción en "/" (pública, indexable — ver
// index.html). Propuesta de valor para hoteles boutique/independientes en México
// (H01/H18): recepción por WhatsApp y voz, reservas y disponibilidad, housekeeping,
// back office y CFDI, agentes con aprobación humana — con capturas REALES del producto
// (tests/e2e/screenshots, copiadas a public/landing/). Planes y precios son PROPUESTA
// (H18), pendientes de aprobación del fundador (docs/BLOQUEOS.md D-006) — nunca se
// muestran como precio de lista definitivo.
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  MessageCircle,
  CalendarCheck,
  Sparkles,
  Building2,
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { AtiendeWordmark, Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Separator } from "@atiende/ui";
import { CookieConsentBanner } from "../components/CookieConsentBanner";
import { listarPlanes } from "../lib/api";
import { track } from "../lib/analytics";

const NUMERO_WHATSAPP_VENTAS = "+52 1 998 000 0000"; // [PENDIENTE] número real de ventas — placeholder honesto hasta que exista línea comercial.

const SECCIONES_PRODUCTO = [
  {
    id: "recepcion",
    icon: MessageCircle,
    titulo: "Recepción por WhatsApp y voz",
    descripcion:
      "Tus huéspedes reservan, preguntan y resuelven dudas por WhatsApp o por teléfono, en el idioma en que te escriben. El agente conversacional responde 24/7 y transfiere a una persona del hotel en cualquier momento si el huésped lo pide.",
    imagen: "/landing/recepcion-whatsapp-voz.png",
    alt: "Panel de mensajería de Atiende Hoteles mostrando una conversación de WhatsApp con un huésped",
  },
  {
    id: "reservas",
    icon: CalendarCheck,
    titulo: "Reservas y disponibilidad",
    descripcion:
      "Calendario de disponibilidad, tarifas por temporada y motor de cotización propio (noches × tarifa + IVA/ISH) sin migrar tu PMS actual. Onboarding funcional en menos de 8 días, con tu historial de los últimos 12 meses ya cargado.",
    imagen: "/landing/reservas-disponibilidad.png",
    alt: "Tabla de reservas de Atiende Hoteles con filtros de fecha y estado",
  },
  {
    id: "housekeeping",
    icon: Sparkles,
    titulo: "Housekeeping y mantenimiento",
    descripcion:
      "Estado de habitación en tiempo real, checklist de limpieza y tickets de mantenimiento con severidad y aprobación de gasto — todo desde el celular del personal, sin capacitación larga.",
    imagen: "/landing/housekeeping.png",
    alt: "Panel de housekeeping de Atiende Hoteles con el estado de cada habitación",
  },
  {
    id: "back-office",
    icon: Building2,
    titulo: "Back office y CFDI",
    descripcion:
      "Night audit automatizado, folio de consumo y CFDI 4.0 de hospedaje (extranjero, factura global, anticipos) sin depender de que tu contador cierre a mano cada noche.",
    imagen: "/landing/back-office-cfdi.png",
    alt: "Panel de back office de Atiende Hoteles con el resumen del corte de caja",
  },
  {
    id: "agentes",
    icon: ShieldCheck,
    titulo: "Agentes de IA con aprobación humana",
    descripcion:
      "Cada agente reporta el valor que genera con la misma transparencia con la que se le cobra — y ninguna acción irreversible (un cargo, un reembolso, un mensaje masivo) se ejecuta sin que una persona del hotel la apruebe primero.",
    imagen: "/landing/agentes-aprobacion.png",
    alt: "Bandeja de aprobaciones de Atiende Hoteles mostrando una acción de agente pendiente de revisión",
  },
];

const FAQS = [
  {
    pregunta: "¿Tengo que cambiar de PMS para usar Atiende?",
    respuesta:
      "No. Atiende se conecta a tu sistema de gestión hotelera existente (o funciona como tu sistema de reservas si todavía no tienes uno) — el onboarding está diseñado para completarse en menos de 8 días sin migrar nada.",
  },
  {
    pregunta: "¿Qué pasa si el agente de IA se equivoca?",
    respuesta:
      "Ninguna acción con dinero, un mensaje masivo o un cambio irreversible se ejecuta sin que una persona de tu hotel la apruebe primero. El agente propone, tu equipo decide.",
  },
  {
    pregunta: "¿Los precios de los planes son definitivos?",
    respuesta:
      "No todavía: son una propuesta basada en comparables del mercado (Cloudbeds, Mews, Canary, HiJiffy) mientras confirmamos el precio final con los primeros hoteles piloto. Verás la insignia \"propuesta\" en cada plan hasta que se confirme.",
  },
  {
    pregunta: "¿Dónde se procesa la información de mis huéspedes?",
    respuesta:
      "Bajo un aviso de privacidad que declara exactamente qué se recaba, para qué se usa y con qué proveedores se comparte (incluida la transferencia internacional al proveedor de inteligencia artificial). Puedes leerlo completo antes de decidir.",
  },
];

export function Landing() {
  const planesQuery = useQuery({ queryKey: ["planes-landing"], queryFn: () => listarPlanes(), retry: false });

  useEffect(() => {
    track("landing_viewed");
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#contenido-principal"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2"
      >
        Saltar al contenido principal
      </a>

      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <AtiendeWordmark />
          <nav aria-label="Principal" className="hidden md:flex items-center gap-6 text-sm font-medium">
            <a href="#producto" className="text-muted-foreground hover:text-foreground">
              Producto
            </a>
            <a href="#planes" className="text-muted-foreground hover:text-foreground">
              Planes
            </a>
            <a href="#faq" className="text-muted-foreground hover:text-foreground">
              Preguntas frecuentes
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">Iniciar sesión</Link>
            </Button>
            <Button asChild size="sm" onClick={() => track("landing_cta_clicked", { destino: "registro", ubicacion: "header" })}>
              <Link to="/registro">
                Prueba gratis <ArrowRight className="size-4 ml-1" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="contenido-principal">
        {/* Hero */}
        <section
          className="relative overflow-hidden text-white"
          style={{ background: "var(--gradient-hero, linear-gradient(135deg, #1D4ED8 0%, #0369A1 100%))" }}
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24 grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
            <div>
              <Badge variant="secondary" className="mb-4 bg-white/15 text-white border-white/20">
                Hecho para hoteles boutique e independientes en México
              </Badge>
              <h1 className="font-display text-3xl sm:text-5xl font-bold leading-tight">
                Tu hotel, atendido por IA — con una persona siempre a cargo de la decisión final
              </h1>
              <p className="mt-4 text-base sm:text-lg text-white/90 max-w-xl">
                Recepción por WhatsApp y voz, reservas, housekeeping, back office y CFDI en un solo panel. Onboarding funcional en menos
                de 8 días, sin migrar tu PMS actual.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Button
                  asChild
                  size="lg"
                  className="bg-white text-primary hover:bg-white/90"
                  onClick={() => track("landing_cta_clicked", { destino: "registro", ubicacion: "hero" })}
                >
                  <Link to="/registro">
                    Comenzar prueba de 14 días <ArrowRight className="size-4 ml-1.5" aria-hidden="true" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="border-white/40 text-white hover:bg-white/10"
                  onClick={() => track("landing_cta_clicked", { destino: "demo", ubicacion: "hero" })}
                >
                  <a href="#producto">Ver el producto</a>
                </Button>
              </div>
              <p className="mt-4 text-xs text-white/70">Sin tarjeta de crédito para empezar la prueba.</p>
            </div>
            <div className="rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/20">
              <img
                src="/landing/back-office-cfdi.png"
                alt="Captura del panel de Atiende Hoteles mostrando el resumen de back office"
                width={1280}
                height={800}
                className="w-full h-auto"
                loading="eager"
              />
            </div>
          </div>
        </section>

        {/* Producto */}
        <section id="producto" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
          <h2 className="font-display text-2xl sm:text-3xl font-semibold text-center">Todo lo que tu hotel necesita, en un panel</h2>
          <p className="mt-2 text-center text-muted-foreground max-w-2xl mx-auto">
            Capturas reales del producto — no maquetas.
          </p>
          <div className="mt-12 space-y-16">
            {SECCIONES_PRODUCTO.map((seccion, i) => (
              <div
                key={seccion.id}
                className={`grid grid-cols-1 lg:grid-cols-2 gap-8 items-center ${i % 2 === 1 ? "lg:[&>*:first-child]:order-2" : ""}`}
              >
                <div>
                  <div className="inline-flex items-center justify-center size-10 rounded-lg bg-primary/10 text-primary mb-3">
                    <seccion.icon className="size-5" aria-hidden="true" />
                  </div>
                  <h3 className="font-display text-xl font-semibold">{seccion.titulo}</h3>
                  <p className="mt-2 text-muted-foreground">{seccion.descripcion}</p>
                </div>
                <div className="rounded-xl overflow-hidden border border-border shadow-lg">
                  <img src={seccion.imagen} alt={seccion.alt} width={1280} height={800} loading="lazy" className="w-full h-auto" />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Planes */}
        <section id="planes" className="bg-muted/40 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <h2 className="font-display text-2xl sm:text-3xl font-semibold text-center">Planes</h2>
            <p className="mt-2 text-center text-muted-foreground max-w-2xl mx-auto">
              Precios propuestos según comparables de mercado (H18) — <strong>pendientes de aprobación final</strong>. Los tres incluyen
              recepción por WhatsApp/voz, reservas, housekeeping y back office con CFDI.
            </p>
            {planesQuery.isError || planesQuery.data == null ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">
                No se pudo cargar el catálogo de planes en este momento —{" "}
                <a href={`https://wa.me/${NUMERO_WHATSAPP_VENTAS.replace(/\D/g, "")}`} className="text-primary underline">
                  escríbenos por WhatsApp
                </a>{" "}
                y te cotizamos directamente.
              </p>
            ) : (
              <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
                {planesQuery.data.map((plan) => (
                  <Card key={plan.id} className={plan.codigo === "pro" ? "border-primary shadow-lg" : undefined}>
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        {plan.nombre}
                        {plan.codigo === "pro" && <Badge>Más elegido</Badge>}
                      </CardTitle>
                      <CardDescription>
                        {plan.precioMxnCentavos != null ? (
                          <>
                            <span className="text-2xl font-semibold text-foreground">
                              ${(plan.precioMxnCentavos / 100).toLocaleString("es-MX")}
                            </span>{" "}
                            MXN / {plan.ciclo}
                          </>
                        ) : (
                          <span className="text-2xl font-semibold text-foreground">Cotización directa</span>
                        )}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Badge variant="outline" className="text-[10px]">
                        propuesta, pendiente de aprobación
                      </Badge>
                      <ul className="text-sm text-muted-foreground space-y-1.5 mt-2">
                        <li className="flex items-center gap-1.5">
                          <CheckCircle2 className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                          {plan.limites.hoteles ?? "Hoteles ilimitados"} {plan.limites.hoteles ? "hotel(es)" : ""}
                        </li>
                        <li className="flex items-center gap-1.5">
                          <CheckCircle2 className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                          {plan.limites.habitaciones ?? "Habitaciones ilimitadas"} {plan.limites.habitaciones ? "habitaciones" : ""}
                        </li>
                        <li className="flex items-center gap-1.5">
                          <CheckCircle2 className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                          {plan.limites.agentesActivos ?? "Agentes ilimitados"} {plan.limites.agentesActivos ? "agentes activos" : ""}
                        </li>
                      </ul>
                      <Button
                        asChild
                        className="w-full mt-2"
                        onClick={() => track("landing_cta_clicked", { destino: "registro", ubicacion: `plan_${plan.codigo}` })}
                      >
                        <Link to="/registro">{plan.precioMxnCentavos == null ? "Contactar ventas" : "Comenzar prueba"}</Link>
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="max-w-3xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
          <h2 className="font-display text-2xl sm:text-3xl font-semibold text-center">Preguntas frecuentes</h2>
          <div className="mt-8 space-y-4">
            {FAQS.map((faq) => (
              <Card key={faq.pregunta}>
                <CardHeader>
                  <CardTitle className="text-base">{faq.pregunta}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{faq.respuesta}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* CTA final */}
        <section className="bg-primary text-primary-foreground py-16">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center">
            <h2 className="font-display text-2xl sm:text-3xl font-semibold">¿Listo para atender a tus huéspedes con IA supervisada?</h2>
            <p className="mt-2 text-primary-foreground/90">Prueba 14 días gratis. Sin migrar tu PMS. Sin tarjeta de crédito.</p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
              <Button
                asChild
                size="lg"
                variant="secondary"
                onClick={() => track("landing_cta_clicked", { destino: "registro", ubicacion: "cta_final" })}
              >
                <Link to="/registro">Comenzar prueba gratuita</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-white/40 text-white hover:bg-white/10">
                <a href={`https://wa.me/${NUMERO_WHATSAPP_VENTAS.replace(/\D/g, "")}`}>Agendar una demo por WhatsApp</a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <AtiendeWordmark className="scale-90" />
          <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
            <Link to="/privacidad" className="hover:text-foreground">
              Aviso de privacidad
            </Link>
            <Link to="/terminos" className="hover:text-foreground">
              Términos y condiciones
            </Link>
            <Separator orientation="vertical" className="h-4" />
            <span>© {new Date().getFullYear()} Atiende</span>
          </nav>
        </div>
      </footer>

      <CookieConsentBanner />
    </div>
  );
}
