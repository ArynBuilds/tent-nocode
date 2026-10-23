import { useState } from 'react';
import { WhatToBuild } from '../onboarding/WhatToBuild.js';
import dash from './dashboard.module.css';

// Birth ceremony screen to name and choose project kind (app or website).
export function NewProjectScreen({ onCreate }: {
  onCreate: (kind: 'app' | 'website', name: string) => void;
}) {
  const [name, setName] = useState('');
  return (
    <div className={dash.birthWrap}>
      <input
        className={dash.birthName}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name it…"
        aria-label="Project name"
        autoFocus
      />
      <WhatToBuild onPick={(kind) => onCreate(kind, name.trim())} />
    </div>
  );
}
