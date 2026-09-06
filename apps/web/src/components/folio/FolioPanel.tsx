// H5 · Folio del huésped en casa: cargos, pagos, saldo, acciones con confirmación
// (REQ-REC-004/012, REQ-BO-001). Todo cálculo de dinero viene del backend
// (@atiende-hoteles/domain-hotel) -- este componente solo muestra/envía, nunca
// calcula un monto/impuesto por su cuenta.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReceiptText, CreditCard, Undo2, Lock, FileCheck2 } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Badge,
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@atiende/ui";
import { DataState } from "../DataState";
import {
  listarFoliosDeReserva,
  crearCargo,
  crearDescuento,
  reversarCargo,
  crearPago,
  cerrarFolio,
  emitirCfdiHospedaje,
  listarCfdiDeFolio,
  ApiUnavailableError,
  type Folio,
  type ConceptoCargo,
} from "../../lib/api";

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

const CONCEPTOS: { value: ConceptoCargo; label: string }[] = [
  { value: "hospedaje", label: "Hospedaje" },
  { value: "ab", label: "Alimentos y bebidas" },
  { value: "extras", label: "Extras" },
  { value: "ajuste", label: "Ajuste" },
  { value: "propina", label: "Propina (sin impuesto)" },
  { value: "otro", label: "Otro" },
];

export function FolioPanel({ hotelId, reservationId }: { hotelId: string; reservationId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["folios-reserva", hotelId, reservationId],
    queryFn: () => listarFoliosDeReserva(hotelId, reservationId),
    enabled: Boolean(hotelId && reservationId),
    retry: false,
  });

  function invalidar() {
    void queryClient.invalidateQueries({ queryKey: ["folios-reserva", hotelId, reservationId] });
  }

  return (
    <DataState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      mensajeVacio="Esta reserva todavía no tiene folio (se crea al confirmarla)."
      onReintentar={() => query.refetch()}
    >
      {(folios: Folio[]) => (
        <div className="space-y-4">
          {folios.map((folio) => (
            <FolioCard key={folio.id} hotelId={hotelId} folio={folio} onCambio={invalidar} />
          ))}
        </div>
      )}
    </DataState>
  );
}

function FolioCard({ hotelId, folio, onCambio }: { hotelId: string; folio: Folio; onCambio: () => void }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-muted/40">
        <div className="flex items-center gap-2">
          <span className="font-medium">{folio.etiqueta}</span>
          {folio.esPrincipal && <Badge variant="secondary">Principal</Badge>}
          <Badge variant={folio.estado === "abierto" ? "default" : "outline"}>{folio.estado}</Badge>
        </div>
        <div className="text-sm tabular-nums font-semibold">Saldo: ${folio.saldo.toFixed(2)}</div>
      </div>

      {error && (
        <p role="alert" className="px-3 pt-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Concepto</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead className="text-right">Monto</TableHead>
              <TableHead className="text-right">Impuesto</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {folio.cargos.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-sm">
                  Sin cargos todavía.
                </TableCell>
              </TableRow>
            )}
            {folio.cargos.map((c) => (
              <TableRow key={c.id} className={c.revertidoPor ? "opacity-50" : undefined}>
                <TableCell className="capitalize">{c.concepto}</TableCell>
                <TableCell>
                  {c.descripcion} {c.revertidoPor && <span className="text-xs">(reversado)</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">${c.monto.toFixed(2)}</TableCell>
                <TableCell className="text-right tabular-nums">${c.impuesto.toFixed(2)}</TableCell>
                <TableCell className="text-right">
                  {!c.revertidoPor && c.concepto !== "reverso" && folio.estado === "abierto" && (
                    <ReversarCargoBoton
                      hotelId={hotelId}
                      folioId={folio.id}
                      chargeId={c.id}
                      onExito={() => {
                        setError(null);
                        onCambio();
                      }}
                      onError={setError}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="overflow-x-auto border-t border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pago</TableHead>
              <TableHead>Método</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Monto</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {folio.pagos.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-sm">
                  Sin pagos todavía.
                </TableCell>
              </TableRow>
            )}
            {folio.pagos.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.id.slice(0, 8)}</TableCell>
                <TableCell className="capitalize">{p.metodo}</TableCell>
                <TableCell>
                  <Badge variant={p.estado === "capturado" ? "default" : "secondary"}>{p.estado}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">${p.monto.toFixed(2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {folio.estado === "abierto" && (
        <div className="flex flex-wrap gap-2 p-3 border-t border-border">
          <AgregarCargoDialog hotelId={hotelId} folioId={folio.id} onExito={onCambio} onError={setError} />
          <AgregarDescuentoDialog hotelId={hotelId} folioId={folio.id} onExito={onCambio} onError={setError} />
          <AgregarPagoDialog hotelId={hotelId} folioId={folio.id} onExito={onCambio} onError={setError} />
          <CerrarFolioDialog hotelId={hotelId} folioId={folio.id} saldo={folio.saldo} onExito={onCambio} onError={setError} />
        </div>
      )}
      {folio.estado === "cerrado" && (
        <div className="flex flex-wrap gap-2 p-3 border-t border-border">
          <EmitirCfdiDialog hotelId={hotelId} folioId={folio.id} onExito={onCambio} onError={setError} />
          <CfdiEmitidosLista hotelId={hotelId} folioId={folio.id} />
        </div>
      )}
    </div>
  );
}

function ReversarCargoBoton({
  hotelId,
  folioId,
  chargeId,
  onExito,
  onError,
}: {
  hotelId: string;
  folioId: string;
  chargeId: string;
  onExito: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [motivo, setMotivo] = useState("");
  const mutacion = useMutation({
    mutationFn: () => reversarCargo(hotelId, folioId, chargeId, motivo || "Corrección de recepción"),
    onSuccess: () => {
      setOpen(false);
      setMotivo("");
      onExito();
    },
    onError: (err) => onError(mensajeError(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Reversar cargo">
          <Undo2 className="size-4" aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reversar cargo</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          El cargo original NO se borra: queda marcado como reversado y se agrega un cargo nuevo que lo cancela
          (auditable).
        </p>
        <Label htmlFor="motivo-reverso">Motivo</Label>
        <Input id="motivo-reverso" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. cargo duplicado" />
        <DialogFooter>
          <Button onClick={() => mutacion.mutate()} disabled={mutacion.isPending}>
            {mutacion.isPending ? "Reversando..." : "Confirmar reverso"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgregarCargoDialog({
  hotelId,
  folioId,
  onExito,
  onError,
}: {
  hotelId: string;
  folioId: string;
  onExito: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState("");
  const [concepto, setConcepto] = useState<ConceptoCargo>("extras");

  const mutacion = useMutation({
    mutationFn: () => crearCargo(hotelId, folioId, { descripcion, monto: Number(monto), concepto }),
    onSuccess: () => {
      setOpen(false);
      setDescripcion("");
      setMonto("");
      onExito();
    },
    onError: (err) => onError(mensajeError(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ReceiptText className="size-4 mr-1" aria-hidden="true" /> Agregar cargo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agregar cargo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="cargo-descripcion">Descripción</Label>
            <Input id="cargo-descripcion" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="cargo-monto">Monto (antes de impuesto)</Label>
            <Input id="cargo-monto" type="number" min="0.01" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="cargo-concepto">Concepto</Label>
            <select
              id="cargo-concepto"
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={concepto}
              onChange={(e) => setConcepto(e.target.value as ConceptoCargo)}
            >
              {CONCEPTOS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => mutacion.mutate()}
            disabled={mutacion.isPending || !descripcion.trim() || !(Number(monto) > 0)}
          >
            {mutacion.isPending ? "Guardando..." : "Confirmar cargo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgregarDescuentoDialog({
  hotelId,
  folioId,
  onExito,
  onError,
}: {
  hotelId: string;
  folioId: string;
  onExito: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState("");
  const [autorizadoPorUserId, setAutorizadoPorUserId] = useState("");

  const mutacion = useMutation({
    mutationFn: () =>
      crearDescuento(hotelId, folioId, { descripcion, monto: Number(monto), autorizadoPorUserId: autorizadoPorUserId.trim() || null }),
    onSuccess: () => {
      setOpen(false);
      setDescripcion("");
      setMonto("");
      setAutorizadoPorUserId("");
      onExito();
    },
    onError: (err) => onError(mensajeError(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Aplicar descuento
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aplicar descuento</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Un descuento sobre el umbral configurado del hotel requiere autorización de un rol administrativo
          (owner/gm) -- el tuyo o el de otra persona con ese rol.
        </p>
        <div className="space-y-3">
          <div>
            <Label htmlFor="descuento-descripcion">Descripción</Label>
            <Input id="descuento-descripcion" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="descuento-monto">Monto del descuento</Label>
            <Input id="descuento-monto" type="number" min="0.01" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="descuento-autorizacion">ID de usuario que autoriza (si tu rol no basta)</Label>
            <Input
              id="descuento-autorizacion"
              value={autorizadoPorUserId}
              onChange={(e) => setAutorizadoPorUserId(e.target.value)}
              placeholder="Opcional -- solo si el descuento supera el umbral"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => mutacion.mutate()}
            disabled={mutacion.isPending || !descripcion.trim() || !(Number(monto) > 0)}
          >
            {mutacion.isPending ? "Aplicando..." : "Confirmar descuento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgregarPagoDialog({
  hotelId,
  folioId,
  onExito,
  onError,
}: {
  hotelId: string;
  folioId: string;
  onExito: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [monto, setMonto] = useState("");
  const [metodo, setMetodo] = useState<"efectivo" | "transferencia" | "tarjeta">("efectivo");
  const [tokenPago, setTokenPago] = useState("");

  const mutacion = useMutation({
    mutationFn: () => crearPago(hotelId, folioId, { monto: Number(monto), metodo, tokenPago: metodo === "tarjeta" ? tokenPago : undefined }),
    onSuccess: () => {
      setOpen(false);
      setMonto("");
      setTokenPago("");
      onExito();
    },
    onError: (err) => onError(mensajeError(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CreditCard className="size-4 mr-1" aria-hidden="true" /> Registrar pago
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="pago-monto">Monto</Label>
            <Input id="pago-monto" type="number" min="0.01" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pago-metodo">Método</Label>
            <select
              id="pago-metodo"
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={metodo}
              onChange={(e) => setMetodo(e.target.value as typeof metodo)}
            >
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
              <option value="tarjeta">Tarjeta (vía link de pago tokenizado)</option>
            </select>
          </div>
          {metodo === "tarjeta" && (
            <div>
              <Label htmlFor="pago-token">Token del link de pago</Label>
              <Input
                id="pago-token"
                value={tokenPago}
                onChange={(e) => setTokenPago(e.target.value)}
                placeholder="Nunca se captura el número de tarjeta aquí"
              />
              <p className="text-xs text-muted-foreground mt-1">
                El huésped paga en el link/terminal del PSP; este sistema solo recibe el token, nunca el número de
                tarjeta (pendiente de credenciales del PSP real -- ver README).
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => mutacion.mutate()}
            disabled={mutacion.isPending || !(Number(monto) > 0) || (metodo === "tarjeta" && !tokenPago.trim())}
          >
            {mutacion.isPending ? "Registrando..." : "Confirmar pago"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CerrarFolioDialog({
  hotelId,
  folioId,
  saldo,
  onExito,
  onError,
}: {
  hotelId: string;
  folioId: string;
  saldo: number;
  onExito: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const esSaldoCero = Math.abs(saldo) <= 0.01;
  const [motivo, setMotivo] = useState<"saldo_cero" | "cuenta_por_cobrar">(esSaldoCero ? "saldo_cero" : "cuenta_por_cobrar");

  const mutacion = useMutation({
    mutationFn: () => cerrarFolio(hotelId, folioId, { motivo }),
    onSuccess: () => {
      setOpen(false);
      onExito();
    },
    onError: (err) => onError(mensajeError(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Lock className="size-4 mr-1" aria-hidden="true" /> Cerrar folio
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cerrar folio</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          Saldo actual: <strong className="tabular-nums">${saldo.toFixed(2)}</strong>
        </p>
        {!esSaldoCero && (
          <p className="text-sm text-amber-600">
            El saldo no es cero: solo puede cerrarse como cuenta por cobrar (requiere rol administrativo, owner/gm).
          </p>
        )}
        <Label htmlFor="cierre-motivo">Motivo de cierre</Label>
        <select
          id="cierre-motivo"
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value as typeof motivo)}
          disabled={!esSaldoCero}
        >
          <option value="saldo_cero">Saldo cero</option>
          <option value="cuenta_por_cobrar">Cuenta por cobrar</option>
        </select>
        <DialogFooter>
          <Button onClick={() => mutacion.mutate()} disabled={mutacion.isPending}>
            {mutacion.isPending ? "Cerrando..." : "Confirmar cierre"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmitirCfdiDialog({
  hotelId,
  folioId,
  onExito,
  onError,
}: {
  hotelId: string;
  folioId: string;
  onExito: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [esGlobal, setEsGlobal] = useState(true);
  const [esExtranjero, setEsExtranjero] = useState(false);
  const [rfcReceptor, setRfcReceptor] = useState("");
  const [uuidResultado, setUuidResultado] = useState<string | null>(null);

  const mutacion = useMutation({
    mutationFn: () =>
      emitirCfdiHospedaje(hotelId, folioId, {
        metodoPago: "PUE",
        esGlobal,
        esExtranjero,
        rfcReceptor: esGlobal || esExtranjero ? undefined : rfcReceptor,
        usoCfdi: esGlobal || esExtranjero ? undefined : "G03",
      }),
    onSuccess: (res) => {
      setUuidResultado(res.uuidFiscal);
      onExito();
    },
    onError: (err) => onError(mensajeError(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <FileCheck2 className="size-4 mr-1" aria-hidden="true" /> Emitir CFDI
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Emitir CFDI de hospedaje</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Timbrado vía PAC simulado (real pendiente de credenciales -- ver README de apps/api).
        </p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={esGlobal} onChange={(e) => setEsGlobal(e.target.checked)} /> Factura global
            de público en general
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={esExtranjero}
              onChange={(e) => setEsExtranjero(e.target.checked)}
            /> Huésped extranjero (RFC genérico)
          </label>
          {!esGlobal && !esExtranjero && (
            <div>
              <Label htmlFor="cfdi-rfc">RFC receptor</Label>
              <Input id="cfdi-rfc" value={rfcReceptor} onChange={(e) => setRfcReceptor(e.target.value)} />
            </div>
          )}
        </div>
        {uuidResultado && (
          <p className="text-sm text-green-700 dark:text-green-400" role="status">
            CFDI timbrado. UUID: <span className="font-mono">{uuidResultado}</span>
          </p>
        )}
        <DialogFooter>
          <Button onClick={() => mutacion.mutate()} disabled={mutacion.isPending}>
            {mutacion.isPending ? "Timbrando..." : "Timbrar CFDI"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CfdiEmitidosLista({ hotelId, folioId }: { hotelId: string; folioId: string }) {
  const query = useQuery({
    queryKey: ["cfdi-folio", hotelId, folioId],
    queryFn: () => listarCfdiDeFolio(hotelId, folioId),
    retry: false,
  });
  if (!query.data || query.data.length === 0) return null;
  return (
    <ul className="text-sm space-y-1">
      {query.data.map((cfdi) => (
        <li key={cfdi.id} className="flex items-center gap-2">
          <Badge variant={cfdi.estado === "timbrado" ? "default" : "secondary"}>{cfdi.estado}</Badge>
          <span className="font-mono text-xs">{cfdi.uuidFiscal ?? "pendiente de PAC"}</span>
        </li>
      ))}
    </ul>
  );
}
