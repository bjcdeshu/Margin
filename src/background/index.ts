import { BRAND } from '@shared/brand';
import { getMarginConfig } from '@shared/storage';

// Wave 0 entry stub — owned & implemented in full by Wave 1 `engine-providers`.
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void getMarginConfig();
    console.info(`[${BRAND.name}] Service worker initialized (${BRAND.version})`);
  });
}
