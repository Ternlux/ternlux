import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import FeedbackModal from './FeedbackModal';

// antd reads these in jsdom.
beforeAll(() => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

const settle = async (ms = 50) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim() === text);
const typeInto = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

let root;
let container;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; delete global.fetch; });

test('links to GitHub issues and Reddit, opened in the browser', async () => {
  await act(async () => { root.render(<FeedbackModal open onClose={() => {}} />); });
  await settle();
  const links = [...document.querySelectorAll('.ant-modal a[target="_blank"]')].map((a) => a.getAttribute('href'));
  expect(links).toEqual(['https://github.com/Ternlux/ternlux/discussions/new/choose', 'https://www.reddit.com/r/TernluxCommunity/']);
});

test('an empty form is not sent', async () => {
  global.fetch = jest.fn();
  await act(async () => { root.render(<FeedbackModal open onClose={() => {}} />); });
  await settle();
  await act(async () => { byText('button', 'Send feedback').click(); });
  await settle(200);
  expect(document.body.textContent).toContain('Please write your feedback.');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('the form posts to /api/feedback and thanks the user', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
  await act(async () => { root.render(<FeedbackModal open onClose={() => {}} />); });
  await settle();
  await act(async () => { byText('.ant-segmented-item-label', 'Idea').click(); });
  await act(async () => { typeInto(document.querySelector('.ant-modal textarea'), 'Please add a dark mode to the canvas.'); });
  await act(async () => { typeInto(document.querySelector('#email'), 'tester@example.com'); });
  await act(async () => { byText('button', 'Send feedback').click(); });
  await settle(300);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.ternlux.com/api/feedback');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ category: 'idea', message: 'Please add a dark mode to the canvas.', email: 'tester@example.com' });
  expect(document.body.textContent).toContain('Thanks — your feedback was sent.');
});

test('a server error is shown and the form stays', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({ success: false, error: 'Too much feedback from this address in the last hour. Please try again later.' }) }));
  await act(async () => { root.render(<FeedbackModal open onClose={() => {}} />); });
  await settle();
  await act(async () => { typeInto(document.querySelector('.ant-modal textarea'), 'Something broke when exporting.'); });
  await act(async () => { byText('button', 'Send feedback').click(); });
  await settle(300);
  expect(document.body.textContent).toContain('Too much feedback from this address');
  expect(document.querySelector('.ant-modal textarea')).not.toBeNull();
});
