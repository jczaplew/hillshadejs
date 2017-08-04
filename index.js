'use strict'

const fs = require('fs')
const exec = require('child_process').exec
const request = require('request')
const bboxPolygon = require('@turf/bbox-polygon')
const cover = require('@mapbox/tile-cover')
const async = require('async')
const sharp = require('sharp')

sharp.cache(0)

// Define constants
const TEMP_DIR = `${__dirname}/tmp`
const VALID_FORMATS = ['jpeg', 'tiff', 'png']
const MIN_ZOOM = 0
const MAX_ZOOM = 15

const defaults = {
  format: 'jpeg',
  zoom: 0,
  extent: [-180, -85, 180, 85]
}

/*
@input
  extent: [minlng minlat maxlng maxlat]
  options:
    format: jpeg, tiff, png
    zoom: integer

@output
  Buffer in the specified format
*/
module.exports = (extent, options, hollaback) => {
  // Validate parameters
  if (extent.length < 4 || extent[0] < -180 || extent[1] < -85 || extent[2] > 180 || extent[3] > 85) {
    return hollaback('Invalid extent')
  }
  // Validate each coordinate in the extent
  extent.forEach(coord => {
    if (isNaN(coord)) {
      return hollaback('Extent contains an invalid coordinate')
    }
  })

  // Validate provided zoom level
  if (options && options.zoom && (options.zoom < MIN_ZOOM || options.zoom > MAX_ZOOM)) {
    return hollaback(`Invalid zoom. Zoom must be between ${MIN_ZOOM} and %{MAX_ZOOM}`)
  }

  // Validate provided format
  if (options && options.format && VALID_FORMATS.indexOf(options.format) === -1) {
    return hollaback(`Invalid format. Choose one of the following: ${VALID_FORMATS.join(', ')}`)
  }

  // Use provided parameters or defaults
  extent = extent || defaults.extent
  let zoom = options.zoom || defaults.zoom
  let format = options.format || defaults.format
  const fileName = Math.random().toString(36).substring(15)

  // Create a geojson polygon to feed to tile-cover
  let bounds = bboxPolygon(extent)

  // Generate a list of tiles needed to cover the provided extent
  let tiles = cover.tiles(bounds.geometry, {
    min_zoom: zoom,
    max_zoom: zoom
  })

  if (tiles.length > 50) {
    return hollaback(`Too many tiles are needed to cover this area. Please
      choose a smaller extent or a smaller zoom level.`)
  }
  if (tiles.length === 0) {
    return hollaback(`The provided extent is a negative area.`)
  }

  let tilePaths = tiles.map(tile => {
    return `${TEMP_DIR}/${tile[2]}_${tile[0]}_${tile[1]}.tif`
  })

  async.waterfall([
    (callback) => {
      async.eachLimit(tiles, 10, (tile, done) => {
        request(`https://s3.amazonaws.com/elevation-tiles-prod/geotiff/${tile[2]}/${tile[0]}/${tile[1]}.tif`)
          .pipe(fs.createWriteStream(`${TEMP_DIR}/${tile[2]}_${tile[0]}_${tile[1]}.tif`))
          .on('close', error => {
            if (error) return done(error)
            done()
          })
      }, error => {
        if (error) {
          return callback(error)
        }
        callback()
      })
    },

    // Combine the elevation tiles to a single raster and clip to extent
    (callback) => {
      exec(`gdalwarp -wm 4000 ${tilePaths.join(' ')} -te_srs EPSG:4326 -te ${extent.join(' ')} ${TEMP_DIR}/${fileName}_merged.tif`, (error, stdout, stderror) => {
        if (error) {
          return callback(error)
        }
        callback(null)
      })
    },

    // Generate the hillshade
    (callback) => {
      exec(`gdaldem hillshade -s 3 -az 315 -z 4  ${TEMP_DIR}/${fileName}_merged.tif ${TEMP_DIR}/${fileName}_shaded.tif`, (error, stdout, stderr) => {
        if (error) return callback(error)
        callback(null)
      })
    },

    // Convert the resultant shaded relief tif to the desired format
    (callback) => {
      sharp(`${TEMP_DIR}/${fileName}_shaded.tif`)
        .toFormat(format)
        .toBuffer()
        .then(outputBuffer => {
          callback(null, outputBuffer)
        })
        .catch(error => {
          callback(error)
        })
    },

    // Clean up temporary files
    (jpeg, callback) => {
      let toDelete = tilePaths.concat([ `${TEMP_DIR}/${fileName}_merged.tif`, `${TEMP_DIR}/${fileName}_shaded.tif`])

      async.eachLimit(toDelete, 10, (file, done) => {
        fs.unlink(file, error => {
          done()
        })
      }, error => {
        callback(null, jpeg)
      })
    }

  ], (error, jpeg) => {
    if (error) return hollback(error)
    hollaback(null, jpeg)
  })
}
