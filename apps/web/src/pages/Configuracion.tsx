import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users2, Percent, ShieldAlert } from "lucide-react";
import {
  StatCard,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  ThemeSelector,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Button,
  Input,
  Label,
} from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import {
  listarStaff,
  listarDisponibilidad,
  obtenerImpuestos,
  actualizarImpuestos,
  obtenerPoliticaCancelacion,
  actualizarPoliticaCancelacion,
  actualizarTarifa,
  ApiUnavailableError,
  type StaffCuenta,
  type ConfigImpuestos,
  type PoliticaCancelacion,
} from "../lib/api";

// Solo owner/gm pueden configurar impuestos/política de cancelación/tarifas (mismos
// roles que exige la RLS de packages/db, migrations/0013 y 0004) -- doble capa, la
// autorización real e irrenunciable sigue siendo el backend.
const ROLES_CONFIGURACION_FISCAL = ["owner", "gm"];

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function Configuracion() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["configuracion-staff", hotelActivoId],
    queryFn: () => listarStaff(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  return (
    <div>
      <PageHeader titulo="Configuración" descripcion="Cuentas de personal, roles (owner, gm, frontdesk, reservations, housekeeping, maintenance, fnb, accountant), tarifas e impuestos." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Apariencia</CardTitle>
        </CardHeader>
        <CardContent>
          <ThemeSelector />
        </CardContent>
      </Card>

      <SeccionTarifasEImpuestos hotelId={hotelActivoId} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={Users2} label="Cuentas de personal" value={query.data?.length != null ? String(query.data.length) : "—"} sinDato={query.data?.length == null ? "Pendiente de conexión con el backend." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay cuentas de personal dadas de alta todavía."
        onReintentar={() => query.refetch()}
      >
        {(staff: StaffCuenta[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Correo</TableHead>
                  <TableHead>Rol</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.email}</TableCell>
                    <TableCell className="capitalize">{s.rol}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DataState>
    </div>
  );
}

function SeccionTarifasEImpuestos({ hotelId }: { hotelId: string | null }) {
  const { sesion } = useAuth();
  const puedeConfigurar = Boolean(sesion && ROLES_CONFIGURACION_FISCAL.includes(sesion.rol));

  if (!puedeConfigurar) {
    return (
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="size-4" aria-hidden="true" /> Tarifas e impuestos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Tu rol ({sesion?.rol ?? "sin sesión"}) no tiene permiso para ver ni cambiar tarifas, impuestos ni la
            política de cancelación. Solo propietario/gerencia pueden hacerlo.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <FormularioImpuestos hotelId={hotelId as string} />
      <FormularioPoliticaCancelacion hotelId={hotelId as string} />
      <div className="lg:col-span-2">
        <FormularioTarifaRapida hotelId={hotelId as string} />
      </div>
    </div>
  );
}

function FormularioImpuestos({ hotelId }: { hotelId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["impuestos", hotelId],
    queryFn: () => obtenerImpuestos(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });
  const [ivaPct, setIvaPct] = useState("");
  const [ishPct, setIshPct] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  const datos = query.data;
  const ivaMostrado = ivaPct || (datos ? String(datos.ivaRate * 100) : "");
  const ishMostrado = ishPct || (datos ? String(datos.ishRate * 100) : "");

  const mutacion = useMutation({
    mutationFn: (input: ConfigImpuestos) => actualizarImpuestos(hotelId, input),
    onSuccess: () => {
      setGuardado(true);
      queryClient.invalidateQueries({ queryKey: ["impuestos", hotelId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Percent className="size-4" aria-hidden="true" /> Impuestos (IVA / ISH)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <DataState isLoading={query.isLoading} error={query.error} data={datos ?? undefined} mensajeVacio="Este hotel no tiene impuestos configurados todavía." onReintentar={() => query.refetch()}>
          {() => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                setGuardado(false);
                const iva = Number(ivaMostrado) / 100;
                const ish = Number(ishMostrado) / 100;
                if (!Number.isFinite(iva) || !Number.isFinite(ish) || iva < 0 || ish < 0) {
                  setError("Las tasas deben ser números no negativos.");
                  return;
                }
                mutacion.mutate({ ivaRate: iva, ishRate: ish });
              }}
            >
              <p className="text-xs text-muted-foreground">
                Se aplican como parámetros del hotel al motor de cotización (nunca una tasa fija en código): el LLM
                jamás calcula ni decide este número.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="config-iva">IVA (%)</Label>
                  <Input id="config-iva" type="number" min="0" max="100" step="0.01" value={ivaMostrado} onChange={(e) => setIvaPct(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="config-ish">ISH (%)</Label>
                  <Input id="config-ish" type="number" min="0" max="100" step="0.01" value={ishMostrado} onChange={(e) => setIshPct(e.target.value)} />
                </div>
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {guardado && !error && <p className="text-sm text-emerald-600 dark:text-emerald-400">Impuestos actualizados.</p>}
              <Button type="submit" disabled={mutacion.isPending}>
                {mutacion.isPending ? "Guardando…" : "Guardar impuestos"}
              </Button>
            </form>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

function FormularioPoliticaCancelacion({ hotelId }: { hotelId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["politica-cancelacion", hotelId],
    queryFn: () => obtenerPoliticaCancelacion(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });
  const [form, setForm] = useState<PoliticaCancelacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  const actual = form ?? query.data ?? null;

  const mutacion = useMutation({
    mutationFn: (input: PoliticaCancelacion) => actualizarPoliticaCancelacion(hotelId, input),
    onSuccess: () => {
      setGuardado(true);
      queryClient.invalidateQueries({ queryKey: ["politica-cancelacion", hotelId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  function campo(nombre: keyof PoliticaCancelacion, valor: string) {
    const base = actual ?? { freeUntilHours: 24, penaltyPct: 50, noShowPct: 100, depositPct: 20 };
    const num = Number(valor);
    setForm({ ...base, [nombre]: Number.isFinite(num) ? num : 0 });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Política de cancelación</CardTitle>
      </CardHeader>
      <CardContent>
        <DataState isLoading={query.isLoading} error={query.error} data={actual ?? undefined} mensajeVacio="Este hotel no tiene política de cancelación configurada todavía." onReintentar={() => query.refetch()}>
          {(p: PoliticaCancelacion) => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                setGuardado(false);
                mutacion.mutate(p);
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pol-free">Horas libres de penalización</Label>
                  <Input id="pol-free" type="number" min="0" value={p.freeUntilHours} onChange={(e) => campo("freeUntilHours", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pol-penalty">Penalización (%)</Label>
                  <Input id="pol-penalty" type="number" min="0" max="100" value={p.penaltyPct} onChange={(e) => campo("penaltyPct", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pol-noshow">No-show (%)</Label>
                  <Input id="pol-noshow" type="number" min="0" max="100" value={p.noShowPct} onChange={(e) => campo("noShowPct", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pol-deposit">Depósito (%)</Label>
                  <Input id="pol-deposit" type="number" min="0" max="100" value={p.depositPct} onChange={(e) => campo("depositPct", e.target.value)} />
                </div>
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {guardado && !error && <p className="text-sm text-emerald-600 dark:text-emerald-400">Política actualizada.</p>}
              <Button type="submit" disabled={mutacion.isPending}>
                {mutacion.isPending ? "Guardando…" : "Guardar política"}
              </Button>
            </form>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

function FormularioTarifaRapida({ hotelId }: { hotelId: string }) {
  const queryClient = useQueryClient();
  const tiposQuery = useQuery({
    queryKey: ["disponibilidad-resumen", hotelId],
    queryFn: () => listarDisponibilidad(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });

  const [roomTypeId, setRoomTypeId] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [precio, setPrecio] = useState("");
  const [minStay, setMinStay] = useState("1");
  const [cerradoLlegada, setCerradoLlegada] = useState(false);
  const [cerradoSalida, setCerradoSalida] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<string | null>(null);

  const mutacion = useMutation({
    mutationFn: () =>
      actualizarTarifa(hotelId, {
        roomTypeId,
        desde,
        hasta,
        price: Number(precio),
        minStay: Number(minStay) || 1,
        closedToArrival: cerradoLlegada,
        closedToDeparture: cerradoSalida,
      }),
    onSuccess: () => {
      setResultado(`Tarifa actualizada del ${desde} al ${hasta}.`);
      queryClient.invalidateQueries({ queryKey: ["disponibilidad-grid", hotelId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const valido = useMemo(
    () => Boolean(roomTypeId && desde && hasta && hasta >= desde && Number(precio) >= 0),
    [roomTypeId, desde, hasta, precio],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tarifas por rango de fechas</CardTitle>
      </CardHeader>
      <CardContent>
        <DataState isLoading={tiposQuery.isLoading} error={tiposQuery.error} data={tiposQuery.data} mensajeVacio="No hay tipos de habitación configurados." onReintentar={() => tiposQuery.refetch()}>
          {(tipos) => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                setResultado(null);
                mutacion.mutate();
              }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="tarifa-tipo">Tipo de habitación</Label>
                  <select
                    id="tarifa-tipo"
                    required
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={roomTypeId}
                    onChange={(e) => setRoomTypeId(e.target.value)}
                  >
                    <option value="" disabled>
                      Selecciona un tipo de habitación
                    </option>
                    {tipos.map((t) => (
                      <option key={t.tipoHabitacionId} value={t.tipoHabitacionId}>
                        {t.tipoHabitacion}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarifa-desde">Desde</Label>
                  <Input id="tarifa-desde" type="date" required value={desde} onChange={(e) => setDesde(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarifa-hasta">Hasta</Label>
                  <Input id="tarifa-hasta" type="date" required min={desde || undefined} value={hasta} onChange={(e) => setHasta(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarifa-precio">Precio por noche</Label>
                  <Input id="tarifa-precio" type="number" min="0" step="0.01" required value={precio} onChange={(e) => setPrecio(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tarifa-minstay">Estadía mínima (noches)</Label>
                  <Input id="tarifa-minstay" type="number" min="1" value={minStay} onChange={(e) => setMinStay(e.target.value)} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cerradoLlegada} onChange={(e) => setCerradoLlegada(e.target.checked)} />
                  Cerrado a llegadas (CTA)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cerradoSalida} onChange={(e) => setCerradoSalida(e.target.checked)} />
                  Cerrado a salidas (CTD)
                </label>
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {resultado && !error && <p className="text-sm text-emerald-600 dark:text-emerald-400">{resultado}</p>}
              <Button type="submit" disabled={!valido || mutacion.isPending}>
                {mutacion.isPending ? "Guardando…" : "Guardar tarifa"}
              </Button>
            </form>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
