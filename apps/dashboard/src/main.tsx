import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function App() {
  return <main>
    <p className="eyebrow">Ered Luin · G0 foundation</p>
    <h1>Execution controls</h1>
    <section aria-label="Runtime mode">
      <div><span>Execution mode</span><strong>Paper only</strong></div>
      <div><span>Paid Nansen requests</span><strong>Disabled · 0 credits</strong></div>
      <div><span>Live signing</span><strong>Disabled</strong></div>
    </section>
    <p className="note">G0 scaffold. No signals, decisions, or execution receipts are connected yet.</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
