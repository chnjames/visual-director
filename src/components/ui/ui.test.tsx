import { render, screen } from '@testing-library/react';
import { Badge } from './badge';
import { Button } from './button';
import { Field } from './field';
import { Input } from './input';

describe('ui primitives', () => {
  it('主按钮可点击，危险按钮带文字', () => {
    render(
      <>
        <Button variant="primary">发布</Button>
        <Button variant="danger">删除</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: '发布' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除' })).toHaveClass('text-failure');
  });

  it('字段标签常显，错误紧邻', () => {
    render(
      <Field label="接入点" htmlFor="ep" error="只允许接入点 ID">
        <Input id="ep" />
      </Field>,
    );
    expect(screen.getByLabelText('接入点')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('只允许接入点 ID');
  });

  it('状态徽章同时有文字', () => {
    render(<Badge tone="pending">待确认</Badge>);
    expect(screen.getByText('待确认')).toBeInTheDocument();
  });
});
