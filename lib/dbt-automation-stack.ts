import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';


export class DbtStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Register the ECR repository that holds the dbt project image
        const dbtProjectRepo = ecr.Repository.fromRepositoryName(this, 'DbtProjectRepo', 'dbt-project');

        // Import dbt credentials from AWS Secrets Manager
        const dbtCredentials = secretsmanager.Secret.fromSecretCompleteArn(this, 'DbtCredentials', 'arn:aws:secretsmanager:us-east-2:891612547191:secret:dbt-credentials-1kWEiV');

        // Create a role for Lambda with necessary permissions
        const lambdaRole = new iam.Role(this, 'DbtLambdaExecRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        // Add permissions to read the secret and pull the ECR image
        dbtCredentials.grantRead(lambdaRole);
        dbtProjectRepo.grantPull(lambdaRole);

        // Define Lambda function from container image
        const dbtLambda = new lambda.DockerImageFunction(this, 'DbtLambdaFunction', {
            functionName: 'execute-dbt-project',
            code: lambda.DockerImageCode.fromEcr(dbtProjectRepo, {
                tagOrDigest: 'sha256:148f455b25f8ee40e522caaae67c1d7913062d7aee4156752292e1b13a748c9b',
            }),
            timeout: cdk.Duration.minutes(15),
            memorySize: 1024,
            role: lambdaRole,
            environment: {
                DBT_CREDENTIALS_SECRET_ARN: dbtCredentials.secretArn,
            },
        });

        // Configure log retention
        const logGroup = new logs.LogGroup(this, 'DbtLambdaFunctionExecutionLogs', {
            logGroupName: `/aws/lambda/${dbtLambda.functionName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });

        // Create an SNS topic for error notifications
        const errorTopic = new sns.Topic(this, 'DbtLambdaFunctionErrorTopic', {
            displayName: 'DBT Run Errors'
        });

        // Create an SNS topic for invocation notifications
        // Will use this temporarily and delete once I'm confident the Lambda is working
        const invocationTopic = new sns.Topic(this, 'DbtLambdaFunctionInvocationTopic', {
            displayName: 'DBT Invocation'
        });

        // Add email subscriptions
        errorTopic.addSubscription(
            new subscriptions.EmailSubscription('m.adamski3@gmail.com')
        );
        invocationTopic.addSubscription(
            new subscriptions.EmailSubscription('m.adamski3@gmail.com')
        );

        // Create an alarm for Lambda errors
        const errorAlarm = new cloudwatch.Alarm(this, 'DbtLambdaErrorAlarm', {
            alarmDescription: 'Alarm if the DBT Lambda function has errors',
            metric: dbtLambda.metricErrors({
                period: cdk.Duration.minutes(15),
                statistic: 'Sum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        });

        // Create an alarm for Lambda duration (if runs are taking too long)
        const durationAlarm = new cloudwatch.Alarm(this, 'DbtLambdaDurationAlarm', {
            alarmDescription: 'Alarm if the DBT Lambda function takes too long to execute',
            metric: dbtLambda.metricDuration({
                period: cdk.Duration.minutes(15),
                statistic: 'Maximum',
            }),
            threshold: 840, // 14 minutes (close to the 15 minute timeout)
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        });


        const invocationAlarm = new cloudwatch.Alarm(this, 'DbtLambdaInvocationAlarm', {
            alarmDescription: 'Alarm when the DBT Lambda function is invoked',
            metric: dbtLambda.metricInvocations({
                period: cdk.Duration.minutes(15),
                statistic: 'Sum',
            }),
            threshold: 1, // 14 minutes (close to the 15 minute timeout)
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        });

        // Connect alarms to the SNS topic
        errorAlarm.addAlarmAction(new actions.SnsAction(errorTopic));
        durationAlarm.addAlarmAction(new actions.SnsAction(errorTopic));
        invocationAlarm.addAlarmAction(new actions.SnsAction(invocationTopic));

        // Schedule the Lambda to run daily
        const rule = new events.Rule(this, 'DbtDailySchedule', {
            schedule: events.Schedule.cron({ minute: '30', hour: '9' }), // Schedule after Fivetran sync, which runs daily at 08:45 UTC
            description: 'Trigger daily dbt run',
        });

        rule.addTarget(new targets.LambdaFunction(dbtLambda));
    }
}