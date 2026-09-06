import { Link } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted px-6 text-center">
      <AtiendeWordmark />
      <div>
        <h1 className="mb-2 font-display text-4xl font-bold text-foreground">404</h1>
        <p className="mb-4 text-lg text-muted-foreground">Esta página no existe.</p>
        <Link to="/resumen" className="text-primary underline underline-offset-2 hover:text-primary/90">
          Volver al panel
        </Link>
      </div>
    </div>
  );
}
