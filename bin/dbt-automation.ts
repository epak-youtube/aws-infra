#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DbtStack } from '../lib/dbt-automation-stack';

const app = new cdk.App();
new DbtStack(app, 'DbtAutomation', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});