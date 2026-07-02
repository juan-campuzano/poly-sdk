import React, { useState, useEffect } from 'react';
import { useInput, useApp } from 'ink';
import type { StrategyKind, StrategyMode } from '../controllers/types.ts';
import { AppStore, type AppState } from '../engine/store.ts';
import { Orchestrator } from '../engine/orchestrator.ts';
import { Dashboard } from './Dashboard.tsx';
import { StrategyMenu, type MenuAction } from './StrategyMenu.tsx';
import { ConfirmLiveModal } from './ConfirmLiveModal.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { QuitGuard } from './QuitGuard.tsx';
import { SimulationScreen } from './SimulationScreen.tsx';

const KINDS: StrategyKind[] = ['arbitrage', 'copy-trade', 'dip-arb'];

type Screen =
  | { name: 'dashboard' }
  | { name: 'strategy-menu'; kind: StrategyKind }
  | { name: 'confirm-live'; kind: StrategyKind }
  | { name: 'settings'; kind: StrategyKind }
  | { name: 'simulation' }
  | { name: 'quit-guard' };

export function App({ store, orchestrator }: { store: AppStore; orchestrator: Orchestrator }) {
  const { exit } = useApp();
  const [appState, setAppState] = useState<AppState>(store.getState());
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    return store.subscribe((s) => setAppState({ ...s }));
  }, [store]);

  const selectedKind = KINDS[selectedIdx];

  useInput((input, key) => {
    if (screen.name === 'dashboard') {
      if (key.leftArrow) setSelectedIdx((i) => (i - 1 + KINDS.length) % KINDS.length);
      if (key.rightArrow) setSelectedIdx((i) => (i + 1) % KINDS.length);
      if (key.return) setScreen({ name: 'strategy-menu', kind: selectedKind });
      if (input === 's' || input === 'S') setScreen({ name: 'settings', kind: selectedKind });
      if (input === 'r' || input === 'R') setScreen({ name: 'simulation' });
      if (input === 'q' || input === 'Q' || key.ctrl && input === 'c') {
        if (orchestrator.hasOpenLivePositions()) {
          setScreen({ name: 'quit-guard' });
        } else {
          orchestrator.shutdown().then(() => exit()).catch(() => exit());
        }
      }
    }
    if (screen.name !== 'dashboard' && key.escape) {
      if (screen.name === 'strategy-menu' || screen.name === 'settings' || screen.name === 'simulation') {
        setScreen({ name: 'dashboard' });
      }
    }
    if (screen.name === 'settings' && key.escape) {
      setScreen({ name: 'dashboard' });
    }
  });

  const handleMenuAction = (kind: StrategyKind, action: MenuAction) => {
    if (action.type === 'back') { setScreen({ name: 'dashboard' }); return; }
    if (action.type === 'start') { orchestrator.start(kind); setScreen({ name: 'dashboard' }); }
    else if (action.type === 'pause') { orchestrator.pause(kind); setScreen({ name: 'dashboard' }); }
    else if (action.type === 'resume') { orchestrator.resume(kind); setScreen({ name: 'dashboard' }); }
    else if (action.type === 'stop') { orchestrator.stop(kind); setScreen({ name: 'dashboard' }); }
    else if (action.type === 'setMode') {
      if (action.mode === 'live') {
        setScreen({ name: 'confirm-live', kind });
      } else {
        orchestrator.setMode(kind, 'dry-run');
        setScreen({ name: 'dashboard' });
      }
    }
  };

  if (screen.name === 'dashboard') {
    return (
      <Dashboard
        state={appState}
        selectedKind={selectedKind}
        onSelect={(k) => setSelectedIdx(KINDS.indexOf(k))}
      />
    );
  }

  if (screen.name === 'strategy-menu') {
    return (
      <StrategyMenu
        state={appState}
        kind={screen.kind}
        onAction={(a) => handleMenuAction(screen.kind, a)}
      />
    );
  }

  if (screen.name === 'confirm-live') {
    return (
      <ConfirmLiveModal
        kind={screen.kind}
        onConfirm={() => {
          orchestrator.setMode(screen.kind, 'live');
          setScreen({ name: 'dashboard' });
        }}
        onCancel={() => setScreen({ name: 'dashboard' })}
      />
    );
  }

  if (screen.name === 'settings') {
    return (
      <SettingsScreen
        state={appState}
        kind={screen.kind}
        onApply={(target, value) => {
          if (target.type === 'bankroll') {
            orchestrator.setBankrollTotal(value);
          } else {
            orchestrator.updateParams(target.kind, { [target.key]: value });
          }
        }}
        onBack={() => setScreen({ name: 'dashboard' })}
      />
    );
  }

  if (screen.name === 'simulation') {
    return (
      <SimulationScreen
        state={appState}
        onBack={() => setScreen({ name: 'dashboard' })}
      />
    );
  }

  if (screen.name === 'quit-guard') {
    return (
      <QuitGuard
        state={appState}
        onConfirm={() => {
          orchestrator.shutdown().then(() => exit()).catch(() => exit());
        }}
        onCancel={() => setScreen({ name: 'dashboard' })}
      />
    );
  }

  return null;
}
