import React from 'react';
import { createRoot } from 'react-dom/client';
import StudyApp from './StudyApp';
import AuthGate from './AuthGate';

const root = createRoot(document.getElementById('root')!);
root.render(<AuthGate><StudyApp /></AuthGate>);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
}
