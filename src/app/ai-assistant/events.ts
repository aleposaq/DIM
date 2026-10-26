import { EventBus } from 'app/utils/observable';

/** Fire this to open or close the AI assistant panel. */
export const toggleAiAssistant$ = new EventBus<void>();
