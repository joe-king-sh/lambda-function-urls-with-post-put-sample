import * as lambdaPython from "@aws-cdk/aws-lambda-python-alpha";
import * as cdk from "aws-cdk-lib";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  LambdaEdgeEventType,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export class ServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Lambda関数
     */
    const lambdaFunction = new cdk.aws_lambda.Function(this, "Lambda", {
      code: cdk.aws_lambda.Code.fromInline(`
def handler(_event, _context):
    return {
        'statusCode': 200,
        'body': 'Hello from Lambda!'
    }
`),
      handler: "index.handler",
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      memorySize: 1769,
      timeout: cdk.Duration.minutes(15),
    });

    const lambdaFunctionUrl = lambdaFunction.addFunctionUrl({
      authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedMethods: [cdk.aws_lambda.HttpMethod.ALL],
        allowedOrigins: ["*"],
      },
    });

    new cdk.CfnOutput(this, "LambdaFunctionUrl", {
      value: lambdaFunctionUrl.url,
    });

    /**
     * CloudFront
     */
    const cloudFrontDistribution = new Distribution(this, "Default", {
      defaultBehavior: {
        origin: new cdk.aws_cloudfront_origins.FunctionUrlOrigin(
          lambdaFunctionUrl,
        ),
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        edgeLambdas: [
          {
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: cdk.aws_lambda.Version.fromVersionArn(
              this,
              "OriginRequestSigv4SignerFn",
              this.getLambdaEdgeArn(
                "/LambdaFunctionUrlsSigv4SignerSample/LambdaEdgeArn",
              ),
            ),
            includeBody: true,
          },
        ],
      },
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_200,
    });

    const cfnOriginAccessControl =
      new cdk.aws_cloudfront.CfnOriginAccessControl(
        this,
        "OriginAccessControl",
        {
          originAccessControlConfig: {
            name: "Origin Access Control for Lambda Function URLs",
            originAccessControlOriginType: "lambda",
            signingBehavior: "always",
            signingProtocol: "sigv4",
          },
        },
      );

    const cfnDistribution = cloudFrontDistribution.node
      .defaultChild as cdk.aws_cloudfront.CfnDistribution;

    // Set OAC
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId",
      cfnOriginAccessControl.attrId,
    );

    lambdaFunction.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${
        cdk.Stack.of(this).account
      }:distribution/${cloudFrontDistribution.distributionId}`,
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionUrl", {
      value: `https://${cloudFrontDistribution.distributionDomainName}`,
    });
  }

  getLambdaEdgeArn(lambdaArnParamKey: string): string {
    const lambdaEdgeArnParameter = new AwsCustomResource(
      this,
      "LambdaEdgeCustomResource",
      {
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["ssm:GetParameter*"],
            resources: [
              this.formatArn({
                service: "ssm",
                region: "us-east-1",
                resource: "*",
              }),
            ],
          }),
        ]),
        onUpdate: {
          service: "SSM",
          action: "getParameter",
          parameters: { Name: lambdaArnParamKey },
          physicalResourceId: PhysicalResourceId.of(
            `PhysicalResourceId-${Date.now()}`,
          ),
          region: "us-east-1",
        },
      },
    );
    return lambdaEdgeArnParameter.getResponseField("Parameter.Value");
  }
}
