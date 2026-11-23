import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'NOVANTIQ WMS',
  description: 'Sistema de gestión de almacenes: mapa en vivo, clarks y slotting inteligente',
  manifest: '/manifest.json',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <nav className="nav">
          <div className="brand"><span className="mark">N</span><b>NOVANTIQ WMS</b></div>
          <Link href="/">Dashboard</Link>
          <Link href="/mapa">Mapa en vivo</Link>
          <Link href="/clark">App del clark</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
