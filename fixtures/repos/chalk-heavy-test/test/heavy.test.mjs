// Zero-dependency regression suite for the vendored chalk snapshot: this
// isolated fixture copy ships with no node_modules, so it cannot run
// chalk's own ava-based suite. Uses only node:test and node:assert, which
// ship with node itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chalk } from '../source/index.js';

const chalk = new Chalk({level: 3});

test('base function applies no styling', () => {
	assert.equal(chalk('foo'), 'foo');
});

test('single style: red', () => {
	assert.equal(chalk.red('foo'), "\u001b[31mfoo\u001b[39m");
});

test('single style: bold', () => {
	assert.equal(chalk.bold('foo'), "\u001b[1mfoo\u001b[22m");
});

test('single style: underline', () => {
	assert.equal(chalk.underline('foo'), "\u001b[4mfoo\u001b[24m");
});

test('single style: bgGreen', () => {
	assert.equal(chalk.bgGreen('foo'), "\u001b[42mfoo\u001b[49m");
});

test('level 0 disables styling regardless of chain length', () => {
	const plain = new Chalk({level: 0});
	assert.equal(plain.red.bold('foo'), 'foo');
});

test('chained style: red.bold', () => {
	assert.equal(chalk.red.bold('foo'), "\u001b[31m\u001b[1mfoo\u001b[22m\u001b[39m");
});

test('chained style: underline.red', () => {
	assert.equal(chalk.underline.red('foo'), "\u001b[4m\u001b[31mfoo\u001b[39m\u001b[24m");
});

test('chained style: three deep (red.bgGreen.underline)', () => {
	assert.equal(
		chalk.red.bgGreen.underline('foo'),
		"\u001b[31m\u001b[42m\u001b[4mfoo\u001b[24m\u001b[49m\u001b[39m",
	);
});

test('chained style: bold.underline', () => {
	assert.equal(chalk.bold.underline('foo'), "\u001b[1m\u001b[4mfoo\u001b[24m\u001b[22m");
});
