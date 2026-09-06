import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtiendeWordmark,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import { useAuth } from "../hooks/useAuth";
import { useHotel } from "../hooks/useHotel";
import {
  ApiUnavailableError,
  ETIQUETA_ROL,
  HOTEL_ROLES,
  actualizarZonaHorariaOnboarding,
  crearInvitacionStaff,
  crearTipoHabitacionOnboarding,
  listarDisponibilidad,
  listarInvitacionesStaff,
  revocarInvitacionStaff,
  type HotelRole,
} from "../lib/api";

// Mismos roles que exige el backend (`ADMIN_ROLES`, apps/api/src/domain/roles.ts) para
// las rutas de onboarding -- espejo de solo lectura, la autoridad real sigue siendo el
// backend (un desface aquí produce a lo sumo un 403 de más, nunca de menos).
const ROLES_ONBOARDING = ["owner", "gm"];

const ZONAS_HORARIAS_MX = [
  { value: "America/Mexico_City", etiqueta: "Ciudad de México (America/Mexico_City)" },
  { value: "America/Cancun", etiqueta: "Cancún / Riviera Maya (America/Cancun)" },
  { value: "America/Tijuana", etiqueta: "Tijuana / Baja California (America/Tijuana)" },
  { value: "America/Chihuahua", etiqueta: "Chihuahua (America/Chihuahua)" },
  { value: "America/Hermosillo", etiqueta: "Hermosillo / Sonora (America/Hermosillo)" },
];

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

/**
 * `/onboarding` — wizard de 3 pasos para un hotel recién dado de alta (tipos de
 * habitación + tarifa base, zona horaria, invitar equipo).
 *
 * Decisión de layout: vive FUERA de `AppShell` (la barra lateral con los módulos
 * completos del panel). Un hotel recién creado no tiene ningún dato todavía —
 * reservas, disponibilidad, housekeeping, etc. — así que envolver el wizard en esa
 * barra lateral solo mostraría "Sin datos" en once secciones a la vez, una distracción
 * para el único flujo que de verdad importa en este momento. En vez de eso, un layout
 * propio y mínimo enfocado solo en completar el wizard; "Ir a mi panel" al final
 * navega a `/resumen`, donde ya vive el `AppShell` completo.
 *
 * Decisión de navegación: NO hay redirección automática hacia aquí tras el login. El
 * backend no expone ninguna bandera de "onboarding pendiente/completo" en la sesión —
 * inventar esa señal en el cliente (ej. "si no tiene tipos de habitación, mándalo a
 * onboarding") sería adivinar un estado que la API nunca declaró, y esta app nunca
 * finge saber algo que no le consta. `/onboarding` es simplemente una ruta protegida
 * más, alcanzable desde el enlace del correo de bienvenida (`renderBienvenidaHotel`)
 * o navegando ahí directamente.
 */
export function Onboarding() {
  const { sesion } = useAuth();
  const { hotelActivoId, cargando, error } = useHotel();
  const navigate = useNavigate();
  const [paso, setPaso] = useState<"habitaciones" | "zona-horaria" | "equipo">("habitaciones");

  const puedeConfigurar = Boolean(sesion && ROLES_ONBOARDING.includes(sesion.rol));

  if (cargando) {
    return (
      <ShellOnboarding>
        <EstadoCargando etiqueta="Cargando tu hotel…" />
      </ShellOnboarding>
    );
  }

  if (error) {
    return (
      <ShellOnboarding>
        <EstadoError integracion="API de Atiende Hoteles" />
      </ShellOnboarding>
    );
  }

  if (!hotelActivoId) {
    return (
      <ShellOnboarding>
        <EstadoVacio mensaje="Todavía no tienes un hotel asociado a tu cuenta." />
      </ShellOnboarding>
    );
  }

  if (!puedeConfigurar) {
    return (
      <ShellOnboarding>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Tu rol ({sesion?.rol ?? "sin sesión"}) no tiene permiso para completar el onboarding del hotel. Solo
              propietario/gerencia pueden hacerlo.
            </p>
            <Button className="mt-4" onClick={() => navigate("/resumen")}>
              Ir a mi panel
            </Button>
          </CardContent>
        </Card>
      </ShellOnboarding>
    );
  }

  return (
    <ShellOnboarding>
      <Tabs value={paso} onValueChange={(v) => setPaso(v as typeof paso)}>
        <TabsList className="mb-6">
          <TabsTrigger value="habitaciones">1. Habitaciones</TabsTrigger>
          <TabsTrigger value="zona-horaria">2. Zona horaria</TabsTrigger>
          <TabsTrigger value="equipo">3. Tu equipo</TabsTrigger>
        </TabsList>
        <TabsContent value="habitaciones">
          <PasoHabitaciones hotelId={hotelActivoId} onSiguiente={() => setPaso("zona-horaria")} />
        </TabsContent>
        <TabsContent value="zona-horaria">
          <PasoZonaHoraria hotelId={hotelActivoId} onSiguiente={() => setPaso("equipo")} />
        </TabsContent>
        <TabsContent value="equipo">
          <PasoEquipo hotelId={hotelActivoId} onTerminar={() => navigate("/resumen")} />
        </TabsContent>
      </Tabs>
    </ShellOnboarding>
  );
}

function ShellOnboarding({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center justify-between">
          <AtiendeWordmark />
        </header>
        <h1 className="font-display text-2xl font-semibold text-foreground">Configura tu hotel</h1>
        <p className="mb-8 mt-1 text-sm text-muted-foreground">
          Unos pasos rápidos antes de empezar a operar: tipos de habitación, zona horaria e invitar a tu equipo.
        </p>
        {children}
      </div>
    </main>
  );
}

function PasoHabitaciones({ hotelId, onSiguiente }: { hotelId: string; onSiguiente: () => void }) {
  const queryClient = useQueryClient();
  // Fuente de verdad real del backend (no un contador local): refleja lo que la API
  // efectivamente ya guardó, no lo que este formulario "cree" haber creado.
  const tiposQuery = useQuery({
    queryKey: ["disponibilidad-resumen", hotelId],
    queryFn: () => listarDisponibilidad(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });

  const [name, setName] = useState("");
  const [maxOccupancy, setMaxOccupancy] = useState("2");
  const [totalRooms, setTotalRooms] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutacion = useMutation({
    mutationFn: () =>
      crearTipoHabitacionOnboarding(hotelId, {
        name: name.trim(),
        maxOccupancy: Number(maxOccupancy) || undefined,
        totalRooms: Number(totalRooms),
        basePrice: Number(basePrice),
      }),
    onSuccess: () => {
      setName("");
      setTotalRooms("");
      setBasePrice("");
      void queryClient.invalidateQueries({ queryKey: ["disponibilidad-resumen", hotelId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const yaHayTipos = (tiposQuery.data?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tipos de habitación y tarifa base</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (name.trim().length < 2 || !totalRooms || !basePrice) {
                setError("Completa el nombre, el número de habitaciones y el precio base.");
                return;
              }
              mutacion.mutate();
            }}
          >
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ob-nombre">Nombre del tipo de habitación</Label>
              <Input id="ob-nombre" placeholder="Estándar" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-ocupacion">Ocupación máxima</Label>
              <Input
                id="ob-ocupacion"
                type="number"
                min="1"
                max="20"
                value={maxOccupancy}
                onChange={(e) => setMaxOccupancy(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-cuartos">Número de habitaciones</Label>
              <Input id="ob-cuartos" type="number" min="1" value={totalRooms} onChange={(e) => setTotalRooms(e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ob-precio">Precio base por noche (MXN)</Label>
              <Input id="ob-precio" type="number" min="0" step="0.01" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {error}
              </p>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={mutacion.isPending}>
                {mutacion.isPending ? "Guardando…" : "Agregar tipo de habitación"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tipos ya creados</CardTitle>
        </CardHeader>
        <CardContent>
          {tiposQuery.isLoading ? (
            <EstadoCargando lineas={2} />
          ) : tiposQuery.error ? (
            <EstadoError integracion="API de Atiende Hoteles" onReintentar={() => tiposQuery.refetch()} />
          ) : !yaHayTipos ? (
            <EstadoVacio mensaje="Todavía no agregas ningún tipo de habitación." />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Habitaciones</TableHead>
                    <TableHead>Tarifa desde</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tiposQuery.data!.map((t) => (
                    <TableRow key={t.tipoHabitacionId}>
                      <TableCell className="font-medium">{t.tipoHabitacion}</TableCell>
                      <TableCell>{t.total}</TableCell>
                      <TableCell>${t.tarifaDesde} MXN</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSiguiente} disabled={!yaHayTipos} variant={yaHayTipos ? "default" : "outline"}>
          Siguiente: zona horaria
        </Button>
      </div>
    </div>
  );
}

function PasoZonaHoraria({ hotelId, onSiguiente }: { hotelId: string; onSiguiente: () => void }) {
  const [timezone, setTimezone] = useState(ZONAS_HORARIAS_MX[0]!.value);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  const mutacion = useMutation({
    mutationFn: () => actualizarZonaHorariaOnboarding(hotelId, timezone),
    onSuccess: () => setGuardado(true),
    onError: (err) => setError(mensajeError(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Zona horaria del hotel</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setGuardado(false);
            mutacion.mutate();
          }}
        >
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="ob-tz">Zona horaria</Label>
            <select
              id="ob-tz"
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                setGuardado(false);
              }}
            >
              {ZONAS_HORARIAS_MX.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.etiqueta}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {guardado && !error && <p className="text-sm text-emerald-600 dark:text-emerald-400">Zona horaria actualizada.</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={mutacion.isPending}>
              {mutacion.isPending ? "Guardando…" : "Guardar zona horaria"}
            </Button>
            <Button type="button" variant="outline" onClick={onSiguiente} disabled={!guardado}>
              Siguiente: invitar equipo
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasoEquipo({ hotelId, onTerminar }: { hotelId: string; onTerminar: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["invitaciones-staff", hotelId],
    queryFn: () => listarInvitacionesStaff(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<HotelRole>("frontdesk");
  const [error, setError] = useState<string | null>(null);

  const invitar = useMutation({
    mutationFn: () => crearInvitacionStaff(hotelId, { email: email.trim(), role }),
    onSuccess: () => {
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: ["invitaciones-staff", hotelId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const revocar = useMutation({
    mutationFn: (tokenId: string) => revocarInvitacionStaff(hotelId, tokenId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["invitaciones-staff", hotelId] }),
    onError: (err) => setError(mensajeError(err)),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invita a tu equipo</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_220px_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (!email.trim()) {
                setError("Escribe el correo de la persona a invitar.");
                return;
              }
              invitar.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="ob-inv-email">Correo</Label>
              <Input id="ob-inv-email" type="email" placeholder="persona@correo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-inv-rol">Rol</Label>
              <select
                id="ob-inv-rol"
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value as HotelRole)}
              >
                {HOTEL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ETIQUETA_ROL[r]}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={invitar.isPending}>
              {invitar.isPending ? "Enviando…" : "Invitar"}
            </Button>
          </form>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invitaciones pendientes</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <EstadoCargando lineas={2} />
          ) : query.error ? (
            <EstadoError integracion="API de Atiende Hoteles" onReintentar={() => query.refetch()} />
          ) : !query.data || query.data.length === 0 ? (
            <EstadoVacio mensaje="Todavía no invitas a nadie de tu equipo." />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Correo</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.email}</TableCell>
                      <TableCell>{ETIQUETA_ROL[inv.rol]}</TableCell>
                      <TableCell className="capitalize">{inv.estado}</TableCell>
                      <TableCell className="text-right">
                        {inv.estado === "pendiente" && (
                          <Button type="button" variant="outline" size="sm" disabled={revocar.isPending} onClick={() => revocar.mutate(inv.id)}>
                            Revocar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onTerminar}>Ir a mi panel</Button>
      </div>
    </div>
  );
}

export default Onboarding;
