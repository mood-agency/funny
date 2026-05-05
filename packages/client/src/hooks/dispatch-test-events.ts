/**
 * Routes test-runner WS events (test:frame / output / status / console /
 * network / error / action) to the test-store and the live browser preview.
 * Pulled out of ws-event-dispatch so the parent doesn't track the dynamic
 * test-store + BrowserPreview imports.
 */
export function dispatchTestEvent(type: string, data: any): boolean {
  switch (type) {
    case 'test:frame':
      import('@/components/test-runner/BrowserPreview').then(({ renderFrame }) => {
        renderFrame(data.data);
      });
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().addFrameToHistory(data.data, data.timestamp);
      });
      return true;
    case 'test:output':
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestOutput(data);
      });
      return true;
    case 'test:status':
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestStatus(data);
      });
      return true;
    case 'test:console':
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestConsole(data);
      });
      return true;
    case 'test:network':
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestNetwork(data);
      });
      return true;
    case 'test:error':
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestError(data);
      });
      return true;
    case 'test:action':
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestAction(data);
      });
      return true;
    default:
      return false;
  }
}
