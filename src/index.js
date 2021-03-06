/* eslint strict:0 */

var fs = require("fs"),
    path = require("path"),

    nsg = require("spritesmith"),
    _ = require("lodash"),
    async = require("async"),
    wrench = require("wrench"),
    glob = require("glob"),
    url = require("url2"),
    json2css = require("json2css"),

    config = require("./config"),
    logger;

var _makeDirectory = function ( dir ) {
  if (!fs.existsSync(dir)) {
    logger.debug("Making folder [[ " + dir + " ]]");
    /* eslint no-octal:0 */
    wrench.mkdirSyncRecursive(dir, 0777);
  }
};

var _buildSpriteConfig = function ( mimosaConfig, folderPath ) {
  // file name is folder name plus .png
  var folderName = path.basename( folderPath );
  var spriteFileName = folderName + ".png";

  // out file for sprite images
  var spriteOutFile = path.join( mimosaConfig.spritesmith.outDirFull, spriteFileName );

  // out file stylesheets
  var stylesheetOutFile = path.join( mimosaConfig.spritesmith.stylesheetOutDirFull, folderName );

  if (mimosaConfig.spritesmith.isStylus) {
    stylesheetOutFile = stylesheetOutFile + ".styl";
  } else {
    stylesheetOutFile = stylesheetOutFile + ".css";
  }

  var nsgConfig = {
    src: glob.sync(path.join(folderPath, "*.png").replace(mimosaConfig.root + path.sep, "")),
    spritePath: spriteOutFile.replace(mimosaConfig.root + path.sep, ""),
    stylesheetPath: stylesheetOutFile.replace(mimosaConfig.root + path.sep, "")
  };

  if (mimosaConfig.spritesmith.commonDirFull) {
    var commonDirFiles = glob.sync(path.join(mimosaConfig.spritesmith.commonDirFull, "*.png").replace(mimosaConfig.root + path.sep, ""))
    nsgConfig.src = nsgConfig.src.concat(commonDirFiles);
  }

  // perform overrides
  if ( typeof mimosaConfig.spritesmith.options === "function") {
    mimosaConfig.spritesmith.options(nsgConfig);
  } else {
    nsgConfig = _.extend(nsgConfig, mimosaConfig.spritesmith.options);
  }

  _makeDirectory( path.dirname( spriteOutFile ) );

  return nsgConfig;
};

var _runJSON2CSS = function ( generatorConfig, images ) {
  var formatOptions = _.extend({
      "format": "stylus"
  }, generatorConfig.json2css),
  json2cssImages = [],
  json2cssImageCommon = {
    total_width: images.properties.width,
    total_height: images.properties.height,
    image: url.relative(generatorConfig.stylesheetPath, generatorConfig.spritePath)
  },
  coordinates = images.coordinates,
  safeBasenameWithoutExtension = function (name) { return path.basename(name).replace(/\.\w+$/, "").replace(/[^a-z0-9]+/gi, "_"); },
  renamer = (generatorConfig.json2css || {}).renamer || function (name, sprite) {
    return sprite + "_" + name;
  },
  spriteName = safeBasenameWithoutExtension(generatorConfig.stylesheetPath);
  formatOptions.formatOpts = _.extend({
    spriteName: spriteName
  }, json2cssImageCommon, formatOptions.formatOpts);
  for (var filename in coordinates)
    if (coordinates.hasOwnProperty(filename)) {
      json2cssImages.push(_.extend(
        coordinates[filename],
        json2cssImageCommon, {
        name: renamer(safeBasenameWithoutExtension(filename), spriteName, filename)
      }));
  }
  fs.writeFileSync(generatorConfig.stylesheetPath, json2css(json2cssImages, formatOptions));
  logger.success( "Stylesheet generated [[ " + generatorConfig.stylesheetPath + " ]]" );
};

var _runSpriteGenerator = function ( generatorConfig, cb ) {
  if ( logger.isDebug ) {
    logger.debug( "Generating sprite with config:" );
    logger.debug( JSON.stringify( generatorConfig, null, 2 ) );
  }

  nsg( generatorConfig, function ( err, res ) {

    if ( err ) {
      logger.error( "Error generating sprite for config", generatorConfig );
      logger.error( err );
    } else {
      fs.writeFileSync(generatorConfig.spritePath, res.image, "binary");
      delete res.image;
      logger.success( "Sprite generated [[ " + generatorConfig.spritePath + " ]]" );
      _runJSON2CSS( generatorConfig, res );
    }
    cb();
  });
};

var _getAllSpriteConfigs = function ( mimosaConfig ) {
  var configs = wrench.readdirSyncRecursive( mimosaConfig.spritesmith.inDirFull ).map( function( shortPath ) {
    // build full path
    return path.join(mimosaConfig.spritesmith.inDirFull, shortPath);
  }).filter( function filterDir( fullpath ) {
    // only care about directories
    return fs.statSync(fullpath).isDirectory();
  }).filter( function filterRootDir( fullpath ) {
    // only care about root directories
    return (path.dirname(fullpath) === mimosaConfig.spritesmith.inDirFull);
  }).filter( function filterCommon( fullpath ) {
    // no common directory
    return (fullpath !== mimosaConfig.spritesmith.commonDirFull);
  }).filter( function filterNoFiles( fullpath ) {
    // remove any folders that have no files in them
    var folderFiles = wrench.readdirSyncRecursive( fullpath ).map( function( shortPath ) {
      return path.join(fullpath, shortPath);
    });

    for (var i in folderFiles) {
      if (fs.statSync(folderFiles[i]).isFile()) {
        return true;
      }
    }

    logger.warn("Sprite folder is empty [[ " + fullpath + " ]]");

    return false;
  }).map( function createSpriteConfigForFolder( fullpath ) {
    return _buildSpriteConfig( mimosaConfig, fullpath );
  });

  return configs;
};

var _generateSprites = function ( mimosaConfig, next ) {

  if ( !fs.existsSync( mimosaConfig.spritesmith.inDirFull ) ) {
    logger.error( "Could not find spritesmith.inDir directory at [[ " + mimosaConfig.spritesmith.inDirFull + " ]]" );
    if ( next ) {
      next();
    }
    return;
  }

  var configs = _getAllSpriteConfigs( mimosaConfig );
  if (configs.length > 0) {
    _makeDirectory( mimosaConfig.spritesmith.stylesheetOutDirFull );
  }
  var templates = ((mimosaConfig.spritesmith.options || {}).json2css || {}).templates;
  if (templates) {
    delete mimosaConfig.spritesmith.options.json2css.templates;
    for (var name in templates)
      if (templates.hasOwnProperty(name)) {
        json2css.addMustacheTemplate(name, templates[name]);
      }
  }
  async.eachSeries( configs, function( config, cb ) {
    _runSpriteGenerator( config, cb );
  });

  if ( next ) {
    next();
  }
};

var registerCommand = function ( program, _logger, retrieveConfig ) {
  logger = _logger;
  program
    .command( "spritesmith" )
    .option("-D, --mdebug", "run in debug mode")
    .description( "Generate image sprites for your Mimosa application" )
    .action( function( opts ){
      var retrieveConfigOpts = {
        mdebug: !!opts.mdebug,
        buildFirst: false
      };

      retrieveConfig( retrieveConfigOpts, function( mimosaConfig ) {
        _generateSprites( mimosaConfig );
      });
    });
};

module.exports = {
  registerCommand: registerCommand,
  defaults: config.defaults,
  validate: config.validate
};
