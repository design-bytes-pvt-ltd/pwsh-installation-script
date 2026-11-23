// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { DetailList } from '../DetailList';

afterEach(cleanup);

describe('DetailList', () => {
  test('one row per item, label as <dt> and value as <dd>', () => {
    render(
      <DetailList
        items={[
          { id: 'code', label: 'Error code', value: 'EB-MODELS-NETWORK' },
          { id: 'log', label: 'Log file', value: '/tmp/install.log' },
        ]}
      />
    );
    expect(screen.getAllByRole('term').map((el) => el.textContent)).toEqual(['Error code', 'Log file']);
    expect(screen.getAllByRole('definition').map((el) => el.textContent)).toEqual(['EB-MODELS-NETWORK', '/tmp/install.log']);
  });

  test('values are selectable and wrap long paths', () => {
    render(<DetailList items={[{ id: 'log', label: 'Log file', value: '/a/very/long/path.log' }]} />);
    const value = screen.getByRole('definition');
    expect(value.className).toContain('select-text');
    expect(value.className).toContain('break-all');
  });
});
