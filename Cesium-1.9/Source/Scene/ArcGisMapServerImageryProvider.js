/*global define*/
define([
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartographic',
        '../Core/Math',
        '../Core/Credit',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/DeveloperError',
        '../Core/Event',
        '../Core/GeographicProjection',
        '../Core/GeographicTilingScheme',
        '../Core/jsonp',
        '../Core/loadJson',
        '../Core/Rectangle',
        '../Core/TileProviderError',
        '../Core/WebMercatorProjection',
        '../Core/WebMercatorTilingScheme',
        '../ThirdParty/when',
        './DiscardMissingTileImagePolicy',
        './ImageryLayerFeatureInfo',
        './ImageryProvider'
    ], function(
        Cartesian2,
        Cartesian3,
        Cartographic,
        CesiumMath,
        Credit,
        defaultValue,
        defined,
        defineProperties,
        DeveloperError,
        Event,
        GeographicProjection,
        GeographicTilingScheme,
        jsonp,
        loadJson,
        Rectangle,
        TileProviderError,
        WebMercatorProjection,
        WebMercatorTilingScheme,
        when,
        DiscardMissingTileImagePolicy,
        ImageryLayerFeatureInfo,
        ImageryProvider) {
    "use strict";

    /**
     * Provides tiled imagery hosted by an ArcGIS MapServer.  By default, the server's pre-cached tiles are
     * used, if available.
     *
     * @alias ArcGisMapServerImageryProvider
     * @constructor
     *
     * @param {Object} options Object with the following properties:
     * @param {String} options.url The URL of the ArcGIS MapServer service.
     * @param {TileDiscardPolicy} [options.tileDiscardPolicy] The policy that determines if a tile
     *        is invalid and should be discarded.  If this value is not specified, a default
     *        {@link DiscardMissingTileImagePolicy} is used for tiled map servers, and a
     *        {@link NeverTileDiscardPolicy} is used for non-tiled map servers.  In the former case,
     *        we request tile 0,0 at the maximum tile level and check pixels (0,0), (200,20), (20,200),
     *        (80,110), and (160, 130).  If all of these pixels are transparent, the discard check is
     *        disabled and no tiles are discarded.  If any of them have a non-transparent color, any
     *        tile that has the same values in these pixel locations is discarded.  The end result of
     *        these defaults should be correct tile discarding for a standard ArcGIS Server.  To ensure
     *        that no tiles are discarded, construct and pass a {@link NeverTileDiscardPolicy} for this
     *        parameter.
     * @param {Proxy} [options.proxy] A proxy to use for requests. This object is
     *        expected to have a getURL function which returns the proxied URL, if needed.
     * @param {Boolean} [options.usePreCachedTilesIfAvailable=true] If true, the server's pre-cached
     *        tiles are used if they are available.  If false, any pre-cached tiles are ignored and the
     *        'export' service is used.
     * @param {String} [layers] A comma-separated list of the layers to show, or undefined if all layers should be shown.
     * @param {Boolean} [options.enablePickFeatures=true] If true, {@link ArcGisMapServerImageryProvider#pickFeatures} will invoke
     *        the Identify service on the MapServer and return the features included in the response.  If false,
     *        {@link ArcGisMapServerImageryProvider#pickFeatures} will immediately return undefined (indicating no pickable features)
     *        without communicating with the server.  Set this property to false if you don't want this provider's features to
     *        be pickable.
     * @param {Rectangle} [options.rectangle=Rectangle.MAX_VALUE] The rectangle of the layer.  This parameter is ignored when accessing
     *                    a tiled layer.
     * @param {TilingScheme} [options.tilingScheme=new GeographicTilingScheme()] The tiling scheme to use to divide the world into tiles.
     *                       This parameter is ignored when accessing a tiled server.
     * @param {Number} [options.tileWidth=256] The width of each tile in pixels.  This parameter is ignored when accessing a tiled server.
     * @param {Number} [options.tileHeight=256] The height of each tile in pixels.  This parameter is ignored when accessing a tiled server.
     *
     * @see BingMapsImageryProvider
     * @see GoogleEarthImageryProvider
     * @see OpenStreetMapImageryProvider
     * @see SingleTileImageryProvider
     * @see TileMapServiceImageryProvider
     * @see WebMapServiceImageryProvider
     *
     * @see {@link http://resources.esri.com/help/9.3/arcgisserver/apis/rest/|ArcGIS Server REST API}
     * @see {@link http://www.w3.org/TR/cors/|Cross-Origin Resource Sharing}
     *
     * @example
     * var esri = new Cesium.ArcGisMapServerImageryProvider({
     *     url: '//services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
     * });
     */
    var ArcGisMapServerImageryProvider = function ArcGisMapServerImageryProvider(options) {
        options = defaultValue(options, {});

        //>>includeStart('debug', pragmas.debug);
        if (!defined(options.url)) {
            throw new DeveloperError('options.url is required.');
        }
        //>>includeEnd('debug');

        this._url = options.url;
        this._tileDiscardPolicy = options.tileDiscardPolicy;
        this._proxy = options.proxy;

        this._tileWidth = defaultValue(options.tileWidth, 256);
        this._tileHeight = defaultValue(options.tileHeight, 256);
        this._maximumLevel = undefined;
        this._tilingScheme = defaultValue(options.tilingScheme, new GeographicTilingScheme());
        this._credit = undefined;
        this._useTiles = defaultValue(options.usePreCachedTilesIfAvailable, true);
        this._rectangle = defaultValue(options.rectangle, this._tilingScheme.rectangle);
        this._layers = options.layers;
        this._enablePickFeatures = defaultValue(options.enablePickFeatures, true);

        this._errorEvent = new Event();

        this._ready = false;

        // Grab the details of this MapServer.
        var that = this;
        var metadataError;

        function metadataSuccess(data) {
            var tileInfo = data.tileInfo;
            if (!defined(tileInfo)) {
                that._useTiles = false;
            } else {
                that._tileWidth = tileInfo.rows;
                that._tileHeight = tileInfo.cols;

                if (tileInfo.spatialReference.wkid === 102100 ||
                    tileInfo.spatialReference.wkid === 102113) {
                    that._tilingScheme = new WebMercatorTilingScheme();
                } else if (data.tileInfo.spatialReference.wkid === 4326) {
                    that._tilingScheme = new GeographicTilingScheme();
                } else {
                    var message = 'Tile spatial reference WKID ' + data.tileInfo.spatialReference.wkid + ' is not supported.';
                    metadataError = TileProviderError.handleError(metadataError, that, that._errorEvent, message, undefined, undefined, undefined, requestMetadata);
                    return;
                }
                that._maximumLevel = data.tileInfo.lods.length - 1;

                if (defined(data.fullExtent)) {
                    if (defined(data.fullExtent.spatialReference) && defined(data.fullExtent.spatialReference.wkid)) {
                        if (data.fullExtent.spatialReference.wkid === 102100 ||
                            data.fullExtent.spatialReference.wkid === 102113) {

                            var projection = new WebMercatorProjection();
                            var sw = projection.unproject(new Cartesian2(data.fullExtent.xmin, data.fullExtent.ymin));
                            var ne = projection.unproject(new Cartesian2(data.fullExtent.xmax, data.fullExtent.ymax));
                            that._rectangle = new Rectangle(sw.longitude, sw.latitude, ne.longitude, ne.latitude);
                        } else if (data.fullExtent.spatialReference.wkid === 4326) {
                            that._rectangle = Rectangle.fromDegrees(data.fullExtent.xmin, data.fullExtent.ymin, data.fullExtent.xmax, data.fullExtent.ymax);
                        } else {
                            var extentMessage = 'fullExtent.spatialReference WKID ' + data.fullExtent.spatialReference.wkid + ' is not supported.';
                            metadataError = TileProviderError.handleError(metadataError, that, that._errorEvent, extentMessage, undefined, undefined, undefined, requestMetadata);
                            return;
                        }
                    }
                } else {
                    that._rectangle = that._tilingScheme.rectangle;
                }

                // Install the default tile discard policy if none has been supplied.
                if (!defined(that._tileDiscardPolicy)) {
                    that._tileDiscardPolicy = new DiscardMissingTileImagePolicy({
                        missingImageUrl : buildImageUrl(that, 0, 0, that._maximumLevel),
                        pixelsToCheck : [new Cartesian2(0, 0), new Cartesian2(200, 20), new Cartesian2(20, 200), new Cartesian2(80, 110), new Cartesian2(160, 130)],
                        disableCheckIfAllPixelsAreTransparent : true
                    });
                }

                that._useTiles = true;
            }

            if (defined(data.copyrightText) && data.copyrightText.length > 0) {
                that._credit = new Credit(data.copyrightText);
            }

            that._ready = true;
            TileProviderError.handleSuccess(metadataError);
        }

        function metadataFailure(e) {
            var message = 'An error occurred while accessing ' + that._url + '.';
            metadataError = TileProviderError.handleError(metadataError, that, that._errorEvent, message, undefined, undefined, undefined, requestMetadata);
        }

        function requestMetadata() {
            var metadata = jsonp(that._url, {
                parameters : {
                    f : 'json'
                },
                proxy : that._proxy
            });
            when(metadata, metadataSuccess, metadataFailure);
        }

        if (this._useTiles) {
            requestMetadata();
        } else {
            this._ready = true;
        }
    };

    function buildImageUrl(imageryProvider, x, y, level) {
        var url;
        if (imageryProvider._useTiles) {
            url = imageryProvider._url + '/tile/' + level + '/' + y + '/' + x;
        } else {
            var nativeRectangle = imageryProvider._tilingScheme.tileXYToNativeRectangle(x, y, level);
            var bbox = nativeRectangle.west + '%2C' + nativeRectangle.south + '%2C' + nativeRectangle.east + '%2C' + nativeRectangle.north;

            url = imageryProvider._url + '/export?';
            url += 'bbox=' + bbox;
            if (imageryProvider._tilingScheme instanceof GeographicTilingScheme) {
                url += '&bboxSR=4326&imageSR=4326';
            } else {
                url += '&bboxSR=3857&imageSR=3857';
            }
            url += '&size=' + imageryProvider._tileWidth + '%2C' + imageryProvider._tileHeight;
            url += '&format=png&transparent=true&f=image';

            if (imageryProvider.layers) {
                url += '&layers=show:' + imageryProvider.layers;
            }
        }

        var proxy = imageryProvider._proxy;
        if (defined(proxy)) {
            url = proxy.getURL(url);
        }

        return url;
    }

    defineProperties(ArcGisMapServerImageryProvider.prototype, {
        /**
         * Gets the URL of the ArcGIS MapServer.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {String}
         * @readonly
         */
        url : {
            get : function() {
                return this._url;
            }
        },

        /**
         * Gets the proxy used by this provider.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Proxy}
         * @readonly
         */
        proxy : {
            get : function() {
                return this._proxy;
            }
        },

        /**
         * Gets the width of each tile, in pixels. This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        tileWidth : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tileWidth must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tileWidth;
            }
        },

        /**
         * Gets the height of each tile, in pixels.  This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        tileHeight: {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tileHeight must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tileHeight;
            }
        },

        /**
         * Gets the maximum level-of-detail that can be requested.  This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        maximumLevel : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('maximumLevel must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._maximumLevel;
            }
        },

        /**
         * Gets the minimum level-of-detail that can be requested.  This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        minimumLevel : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('minimumLevel must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return 0;
            }
        },

        /**
         * Gets the tiling scheme used by this provider.  This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {TilingScheme}
         * @readonly
         */
        tilingScheme : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tilingScheme must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tilingScheme;
            }
        },

        /**
         * Gets the rectangle, in radians, of the imagery provided by this instance.  This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Rectangle}
         * @readonly
         */
        rectangle : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('rectangle must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._rectangle;
            }
        },

        /**
         * Gets the tile discard policy.  If not undefined, the discard policy is responsible
         * for filtering out "missing" tiles via its shouldDiscardImage function.  If this function
         * returns undefined, no tiles are filtered.  This function should
         * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {TileDiscardPolicy}
         * @readonly
         */
        tileDiscardPolicy : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tileDiscardPolicy must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tileDiscardPolicy;
            }
        },

        /**
         * Gets an event that is raised when the imagery provider encounters an asynchronous error.  By subscribing
         * to the event, you will be notified of the error and can potentially recover from it.  Event listeners
         * are passed an instance of {@link TileProviderError}.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Event}
         * @readonly
         */
        errorEvent : {
            get : function() {
                return this._errorEvent;
            }
        },

        /**
         * Gets a value indicating whether or not the provider is ready for use.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Boolean}
         * @readonly
         */
        ready : {
            get : function() {
                return this._ready;
            }
        },

        /**
         * Gets the credit to display when this imagery provider is active.  Typically this is used to credit
         * the source of the imagery.  This function should not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
         * @memberof ArcGisMapServerImageryProvider.prototype
         * @type {Credit}
         * @readonly
         */
        credit : {
            get : function() {
                return this._credit;
            }
        },

        /**
         * Gets a value indicating whether this imagery provider is using pre-cached tiles from the
         * ArcGIS MapServer.  If the imagery provider is not yet ready ({@link ArcGisMapServerImageryProvider#ready}), this function
         * will return the value of `options.usePreCachedTilesIfAvailable`, even if the MapServer does
         * not have pre-cached tiles.
         * @memberof ArcGisMapServerImageryProvider.prototype
         *
         * @type {Boolean}
         * @readonly
         * @default true
         */
        usingPrecachedTiles : {
            get : function() {
                return this._useTiles;
            }
        },

        /**
         * Gets a value indicating whether or not the images provided by this imagery provider
         * include an alpha channel.  If this property is false, an alpha channel, if present, will
         * be ignored.  If this property is true, any images without an alpha channel will be treated
         * as if their alpha is 1.0 everywhere.  When this property is false, memory usage
         * and texture upload time are reduced.
         * @memberof ArcGisMapServerImageryProvider.prototype
         *
         * @type {Boolean}
         * @readonly
         * @default true
         */
        hasAlphaChannel : {
            get : function() {
                return true;
            }
        },

        /**
         * Gets the comma-separated list of layer IDs to show.
         * @type {String}
         */
        layers : {
            get : function() {
                return this._layers;
            }
        },

        /**
         * Gets a value indicating whether feature picking is enabled.  If true, {@link ArcGisMapServerImageryProvider#pickFeatures} will
         * invoke the "identify" operation on the ArcGIS server and return the features included in the response.  If false,
         * {@link ArcGisMapServerImageryProvider#pickFeatures} will immediately return undefined (indicating no pickable features)
         * without communicating with the server.
         * @type {Boolean}
         * @readonly
         * @default true
         */
        enablePickFeatures : {
            get : function() {
                return this._enablePickFeatures;
            }
        }
    });


    /**
     * Gets the credits to be displayed when a given tile is displayed.
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level;
     * @returns {Credit[]} The credits to be displayed when the tile is displayed.
     *
     * @exception {DeveloperError} <code>getTileCredits</code> must not be called before the imagery provider is ready.
     */
    ArcGisMapServerImageryProvider.prototype.getTileCredits = function(x, y, level) {
        return undefined;
    };

    /**
     * Requests the image for a given tile.  This function should
     * not be called before {@link ArcGisMapServerImageryProvider#ready} returns true.
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level.
     * @returns {Promise} A promise for the image that will resolve when the image is available, or
     *          undefined if there are too many active requests to the server, and the request
     *          should be retried later.  The resolved image may be either an
     *          Image or a Canvas DOM object.
     *
     * @exception {DeveloperError} <code>requestImage</code> must not be called before the imagery provider is ready.
     */
    ArcGisMapServerImageryProvider.prototype.requestImage = function(x, y, level) {
        //>>includeStart('debug', pragmas.debug);
        if (!this._ready) {
            throw new DeveloperError('requestImage must not be called before the imagery provider is ready.');
        }
        //>>includeEnd('debug');

        var url = buildImageUrl(this, x, y, level);
        return ImageryProvider.loadImage(this, url);
    };

    /**
    /**
     * Asynchronously determines what features, if any, are located at a given longitude and latitude within
     * a tile.  This function should not be called before {@link ImageryProvider#ready} returns true.
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level.
     * @param {Number} longitude The longitude at which to pick features.
     * @param {Number} latitude  The latitude at which to pick features.
     * @return {Promise} A promise for the picked features that will resolve when the asynchronous
     *                   picking completes.  The resolved value is an array of {@link ImageryLayerFeatureInfo}
     *                   instances.  The array may be empty if no features are found at the given location.
     *
     * @exception {DeveloperError} <code>pickFeatures</code> must not be called before the imagery provider is ready.
     */
    ArcGisMapServerImageryProvider.prototype.pickFeatures = function(x, y, level, longitude, latitude) {
        //>>includeStart('debug', pragmas.debug);
        if (!this._ready) {
            throw new DeveloperError('pickFeatures must not be called before the imagery provider is ready.');
        }
        //>>includeEnd('debug');

        if (!this._enablePickFeatures) {
            return undefined;
        }

        var rectangle = this._tilingScheme.tileXYToNativeRectangle(x, y, level);

        var horizontal;
        var vertical;
        var sr;
        if (this._tilingScheme instanceof GeographicTilingScheme) {
            horizontal = CesiumMath.toDegrees(longitude);
            vertical = CesiumMath.toDegrees(latitude);
            sr = '4326';
        } else {
            var projected = this._tilingScheme.projection.project(new Cartographic(longitude, latitude, 0.0));
            horizontal = projected.x;
            vertical = projected.y;
            sr = '3857';
        }

        var url = this._url + '/identify?f=json&tolerance=2&layers=visible&geometryType=esriGeometryPoint';
        url += '&geometry=' + horizontal + ',' + vertical;
        url += '&mapExtent=' + rectangle.west + ',' + rectangle.south + ',' + rectangle.east + ',' + rectangle.north;
        url += '&imageDisplay=' + this._tileWidth + ',' + this._tileHeight + ',96';
        url += '&sr=' + sr;

        return loadJson(url).then(function(json) {
            var result = [];

            var features = json.results;
            if (!defined(features)) {
                return result;
            }

            for (var i = 0; i < features.length; ++i) {
                var feature = features[i];

                var featureInfo = new ImageryLayerFeatureInfo();
                featureInfo.data = feature;
                featureInfo.name = feature.value;
                featureInfo.properties = feature.attributes;
                featureInfo.configureDescriptionFromProperties(feature.attributes);

                // If this is a point feature, use the coordinates of the point.
                if (feature.geometryType === 'esriGeometryPoint' && feature.geometry) {
                    var wkid = feature.geometry.spatialReference && feature.geometry.spatialReference.wkid ? feature.geometry.spatialReference.wkid : 4326;
                    if (wkid === 4326 || wkid === 4283) {
                        featureInfo.position = Cartographic.fromDegrees(feature.geometry.x, feature.geometry.y, feature.geometry.z);
                    } else if (wkid === 102100 || wkid === 900913 || wkid === 3857) {
                        var projection = new WebMercatorProjection();
                        featureInfo.position = projection.unproject(new Cartesian3(feature.geometry.x, feature.geometry.y, feature.geometry.z));
                    }
                }

                result.push(featureInfo);
            }

            return result;
        });
    };

    return ArcGisMapServerImageryProvider;
});
