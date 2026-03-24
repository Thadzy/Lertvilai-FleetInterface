import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import App from './App';

describe('App', () => {
    it('renders without crashing', () => {
        render(<App />);
        // Just verify that something from the dashboard renders, or just that it doesn't throw
        // Ideally we look for a known text from Dashboard, 
        // but since Dashboard might need configured props/context, this is a basic smoke test.
        // If Dashboard fails to mount, this test will fail.
        expect(document.body).toBeDefined();
    });
});
