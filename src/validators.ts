import {
  Addon,
  AddonActions,
  AddonResponse,
  CatalogOptions,
  CatalogRequest,
  CatalogResponse,
  getClientValidators,
  ItemResponse,
  SimilarItem,
} from "@mediaurl/schema";
import semver from "semver";

const isAddonLegacy = (addon?: Addon) => {
  const sdkVersion = <string>addon?.sdkVersion;
  return !sdkVersion || semver.lt(sdkVersion, "2.0.0-alpha.0");
};

type MigrateResult = {
  action?: string;
  validate?: boolean;
  data: any;
};

type MigrateFn = (data: any, callingAddon?: Addon) => MigrateResult;

type Migrations = Record<
  string,
  {
    request?: MigrateFn;
    response?: MigrateFn;
  }
>;

const migrations: Migrations = {
  addon: {
    response: (data: AddonResponse, callingAddon) => {
      if ((<any>data).type === "server") return { data };

      let addon = <Addon>data;
      let any: any = addon;

      if (isAddonLegacy(addon)) {
        if (any.flags) {
          Object.assign(any, any.flags);
          delete any.flags;
        }

        if (any.metadata?.url) {
          if (!any.endpoints) any.endpoints = [];
          any.endpoints.push(any.metadata.url);
        }
        delete any.metadata;

        if (any.type === "repository") {
          if (!any.actions) any.actions = [];
          any._isLegacyRepositoryAddon = true;
        }
        delete any.type;

        if (any.requestArgs) {
          if (!any.triggers?.length) any.triggers = <any>any.requestArgs;
          delete any.requestArgs;
        }

        if (any.requirements) {
          any.requirements = any.requirements.map((req) =>
            typeof req === "string" ? req : (<any>req).url ?? (<any>req).id
          );
        }

        if (any.actions) {
          const i = any.actions.indexOf(<any>"directory");
          if (i !== -1) {
            any.actions.splice(i, 1, "catalog");
            any.catalogs = <any>any.rootDirectories;
            delete any.rootDirectories;
          }
        }

        if (any.defaultDirectoryOptions || any.defaultDirectoryFeatures) {
          if (!any.catalogs?.length) {
            any.catalogs = [
              {
                addonId: any.id,
                catalogId: "",
                id: "",
                key: `${any.key}/`,
              },
            ];
          }
          any.catalogs = any.catalogs.map((catalog) => ({
            ...catalog,
            options: {
              ...(<any>any.defaultDirectoryOptions),
              ...catalog.options,
            },
            features: {
              ...(<any>any.defaultDirectoryFeatures),
              ...catalog.features,
            },
          }));
          delete any.defaultDirectoryOptions;
          delete any.defaultDirectoryFeatures;
        }

        if (any.dashboards) {
          any.dashboards = any.dashboards.map((dashboard) => {
            dashboard.catalogId = <any>dashboard.rootId;
            delete dashboard.rootId;

            if ((<any>dashboard.config)?.showOnHomescreen === false) {
              dashboard.hideOnHomescreen = true;
              delete dashboard.config;
            }

            if (!dashboard.catalogId && typeof dashboard.id === "string") {
              // This is somehow unsfe, might result in invalid catalog ID's
              const m = /^([^/:]+?)\/(.+)/.exec(dashboard.id);
              if (m) {
                dashboard.catalogId = m[1];
              }
            }

            const showOnHomescreen = (<any>dashboard.config)?.showOnHomescreen;
            if (showOnHomescreen === true || showOnHomescreen === false) {
              dashboard.hideOnHomescreen = !showOnHomescreen;
              delete dashboard.config;
            }

            return dashboard;
          });
        }
      }

      if (!any.pages && any.dashboards) {
        any.pages = [{ dashboards: any.dashboards }];
      }
      delete any.dashboards;

      return { data: addon };
    },
  },
  repository: {
    request: (data: any, callingAddon) => {
      data = getClientValidators().actions.addon.request(data);
      return { data, validate: false };
    },
    response: (data: Addon[], callingAddon) => {
      data = data
        .map(
          (addon) =>
            applyMigration("addon", "response", addon, callingAddon).data
        )
        .map((addon) => getClientValidators().models.addon(addon));
      return { data, validate: false };
    },
  },
  catalog: {
    request: (data: CatalogRequest, callingAddon) => {
      let action: string | undefined = undefined;
      if (isAddonLegacy(callingAddon)) {
        action = "directory";
        data.rootId = data.catalogId;
        delete data.catalogId;
      }
      return { action, data };
    },
    response: (data: CatalogResponse, callingAddon) => {
      if (isAddonLegacy(callingAddon)) {
        const any: any = data;
        if (data.items) {
          data.items = data.items.map((item) => {
            item = applyMigration("item", "response", item, callingAddon).data;
            if (item.type === "directory") {
              item.catalogId = <any>item.rootId;
              delete item.rootId;
            }
            return item;
          });
        }
        data.catalogId = <string>any.rootId;
        delete any.rootId;
      }
      return { data };
    },
  },
  item: {
    response: (data: ItemResponse, callingAddon) => {
      if (isAddonLegacy(callingAddon)) {
        if (data) {
          if (data?.similarItems) {
            data.similarItems = (<SimilarItem[]>data.similarItems).map((s) => {
              s.catalogId = <any>s.rootId;
              delete s.rootId;
              return s;
            });
          }
        }
      }
      return { data };
    },
  },
};

const applyMigration = <T>(
  action: AddonActions,
  type: "request" | "response",
  data: T,
  callingAddon?: Addon
): MigrateResult => {
  const migrate = migrations[action]?.[type];
  if (migrate) return migrate(data, callingAddon);
  return { action, data };
};

export const validateAction = <T>(
  action: AddonActions,
  type: "request" | "response",
  data: T,
  callingAddon?: Addon
) => {
  const res = applyMigration(action, type, data, callingAddon);

  if (res.validate ?? true) {
    const validate = getClientValidators().actions[action]?.[type];
    if (!validate) {
      throw new Error(`No validator for ${action}.${type} found`);
    }
    data = <T>validate(res.data);
  }

  return {
    action: res.action ?? action,
    data,
  };
};
