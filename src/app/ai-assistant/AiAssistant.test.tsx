import { act, fireEvent, render, screen } from '@testing-library/react';
import { noop } from 'app/utils/functions';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router';
import { toggleAiAssistant$ } from './events';

// Sheet renders into #temp-container, which DIM's index.html provides. It's
// looked up when the module loads, so create it before importing the panel.
const tempContainer = document.createElement('div');
tempContainer.id = 'temp-container';
document.body.appendChild(tempContainer);
// Load DIM's real store first to avoid an import cycle through the reducers
const { default: store } = await import('app/store/store');
const { default: AiAssistant } = await import('./AiAssistant');

function renderPanel() {
  return render(
    <MemoryRouter>
      <Provider store={store}>
        <AiAssistant />
      </Provider>
    </MemoryRouter>,
  );
}

// jsdom doesn't have ResizeObserver, which Sheet uses
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;

describe('AiAssistant', () => {
  beforeEach(() => localStorage.clear());

  it('opens and closes from the toggle event', () => {
    renderPanel();
    expect(screen.queryByText('AI Assistant')).toBeNull();

    act(() => toggleAiAssistant$.next());
    expect(screen.getByText('AI Assistant')).toBeTruthy();
    expect(screen.getByText(/Uses Claude/)).toBeTruthy();

    act(() => toggleAiAssistant$.next());
    expect(screen.queryByText('AI Assistant')).toBeNull();
  });

  it('stores the Worker URL in localStorage', () => {
    renderPanel();
    act(() => toggleAiAssistant$.next());
    fireEvent.change(screen.getByPlaceholderText(/workers\.dev/), {
      target: { value: 'https://dim-ai-proxy.test.workers.dev' },
    });
    expect(JSON.parse(localStorage.getItem('dim-ai-proxy-url')!)).toBe(
      'https://dim-ai-proxy.test.workers.dev',
    );
  });
});
