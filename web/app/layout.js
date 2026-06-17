import './globals.css';

export const metadata = {
  title: 'Booking Agent',
  description: 'recreation.gov reservation booking agent',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
