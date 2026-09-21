import { useCallback, useState } from 'react';
import {
  clearModelSettings,
  isImageConfigured,
  isTextConfigured,
  loadModelSettings,
  saveModelSettings,
} from '../shared/security';
import type { ModelSettings } from '../shared/types';

/**
 * 模型设置状态：唯一持久层是 sessionStorage（由 security 模块封装）。
 * 组件不直接触碰 localStorage / IndexedDB / Cookie。
 */
export function useModelSettings() {
  const [settings, setSettings] = useState<ModelSettings | null>(() =>
    loadModelSettings(),
  );

  const save = useCallback((next: ModelSettings) => {
    saveModelSettings(next);
    setSettings(loadModelSettings());
  }, []);

  const clear = useCallback(() => {
    clearModelSettings();
    setSettings(null);
  }, []);

  const configured = isImageConfigured(settings) || isTextConfigured(settings);

  return { settings, configured, save, clear };
}
