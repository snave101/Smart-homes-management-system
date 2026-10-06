'use client';

import getEnv from '@/utils/env/client';
import { useEffect } from 'react';

/**
 * Registers the service worker which makes the app installable.
 * It only works over https or on localhost.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (
      !('serviceWorker' in navigator) ||
      getEnv('NODE_ENV') === 'development'
    ) {
      return;
    }
    const basePath = getEnv('BASE_PATH') || '';
    navigator.serviceWorker
      .register(`${basePath}/sw.js`, { scope: `${basePath}/` })
      .catch((error) => console.warn('service worker not registered', error));
  }, []);

  return null;
}
