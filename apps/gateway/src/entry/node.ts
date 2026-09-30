#!/usr/bin/env bun
import { setExecutableRole } from '../self.js';
import { runNodeEntry } from './node-runtime.js';

setExecutableRole('node');
await runNodeEntry('node');
