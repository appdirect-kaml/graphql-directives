import dateFormat from 'dateformat';
import axios from 'axios';
import crypto from 'crypto';
import { ApolloServer, gql, ApolloError } from 'apollo-server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { mapSchema, getDirective, MapperKind } from '@graphql-tools/utils';
import { defaultFieldResolver, GraphQLObjectType } from 'graphql';

const typeDefs = gql`
  directive @upper on FIELD_DEFINITION
  directive @rest(url: String!) on FIELD_DEFINITION
  directive @auth(role: String!) on FIELD_DEFINITION
  directive @length(min: Int, max: Int) on FIELD_DEFINITION
  directive @uuid(field: String!) on OBJECT
  directive @date(format: String = "mm/dd/yyyy") on FIELD_DEFINITION # Set a default format if not provided

  type Post @uuid(field: "uuid") {
    id: Int!
    uuid: ID!
    userId: Int!
    title: String! @upper
    body: String! @length(min: 10)
    createdAt: String! @date(format: "dddd, mmmm d, yyyy")
  }

  type Query {
    post: Post @auth(role: "ADMIN") @rest(url: "https://jsonplaceholder.typicode.com/posts/1")
  }
`;

const resolvers = {
  Query: {
    async post(_, args) {
      return args.post; // Injected into `args` by the `@rest` directive
    }
  }
};

function upperDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      // `OBJECT_FIELD` is the mapperkind while `FIELD_DEFINITION` is location name in schema
      // Check whether this field has the specified directive
      const upperDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (upperDirective) {
        // Get this field's original resolver
        // If the original resolver is not given, then a default resolve behavior is used
        const { resolve = defaultFieldResolver } = fieldConfig;
        // Replace the original resolver with a function that *first* calls
        // the original resolver, then converts its result to upper case
        fieldConfig.resolve = async function (source, args, context, info) {
          const result = await resolve(source, args, context, info); // Calling the original resolver
          if (typeof result === 'string') return result.toUpperCase(); // Uppercasing the result
          return result;
        };
        return fieldConfig;
      }
    }
  });
}

function dateDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const dateDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (dateDirective) {
        const { resolve = defaultFieldResolver } = fieldConfig;
        const { format } = dateDirective; // Get the directive param
        fieldConfig.resolve = async function (source, args, context, info) {
          const result = await resolve(source, args, context, info);
					if (!result) return null;
          try {
            return dateFormat(result, format);
          } catch {
            throw new ApolloError('Invalid Format!');
          }
        };
        return fieldConfig;
      }
    }
  });
}

function restDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const restDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (restDirective) {
        const { url } = restDirective; // Get the param
        const { resolve = defaultFieldResolver } = fieldConfig;
        fieldConfig.resolve = async function (source, args, context, info) {
          let { data } = await axios.get(url); // Use axios to get the post from a third-party
          // Inject the post in `args` to be able to return it from resolver
          return await resolve(source, { ...args, post: data }, context, info);
        };
        return fieldConfig;
      }
    }
  });
}

function authDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const authDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (authDirective) {
        const { resolve = defaultFieldResolver } = fieldConfig;
        const { role } = authDirective; // Get the directive param
        fieldConfig.resolve = async function (source, args, context, info) {
					// Check the authorization before calling the resolver itself
          if (role !== 'ADMIN') throw new ApolloError('Unauthorized!');
          return await resolve(source, args, context, info);
        };
        return fieldConfig;
      }
    }
  });
}

function uuidDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    // The mapper for OBJECT is OBJECT_TYPE
    [MapperKind.OBJECT_TYPE]: (type) => {
      const uuidDirective = getDirective(schema, type, directiveName)?.[0];
      if (uuidDirective) {
        const { field } = uuidDirective; // Get the directive param
        const config = type.toConfig();
        config.fields[field].resolve = () => crypto.randomUUID();
        return new GraphQLObjectType(config);
      }
    }
  });
}

function lengthDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const lengthDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (lengthDirective) {
        const { resolve = defaultFieldResolver } = fieldConfig;
        const { min, max } = lengthDirective;
        fieldConfig.resolve = async function (source, args, context, info) {
          const result = await resolve(source, args, context, info);
          if (min !== undefined && typeof result === 'string' && result.length < min) {
            throw new ApolloError(
              `The field ${fieldConfig.astNode.name.value} should contain at least ${min} characters`
            );
          }
          if (max !== undefined && typeof result === 'string' && result.length > max) {
            throw new ApolloError(
              `The field ${fieldConfig.astNode.name.value} shouldn't exceed the max length (${max})`
            );
          }
          return result;
        };
        return fieldConfig;
      }
    }
  });
}

let schema = makeExecutableSchema({
  typeDefs,
  resolvers
});

// Transform the schema by applying directive logic
schema = upperDirectiveTransformer(schema, 'upper');
schema = authDirectiveTransformer(schema, 'auth');
schema = restDirectiveTransformer(schema, 'rest');
schema = lengthDirectiveTransformer(schema, 'length');
schema = uuidDirectiveTransformer(schema, 'uuid');
schema = dateDirectiveTransformer(schema, 'date');

const server = new ApolloServer({ schema });

server.listen().then(({ url }) => {
  console.log(`🚀 Server ready at ${url}`);
});
