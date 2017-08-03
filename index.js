'use strict'

const fs = require('fs')
const exec = require('child_process').exec
const request = require('request')
const cover = require('@mapbox/tile-cover')
const buffer = require('@turf/buffer')
const envelope = require('@turf/envelope')
const bbox = require('@turf/bbox')
const bboxPolygon = require('@turf/bbox-polygon')
const async = require('async')
const sharp = require('sharp')

const TEMP_DIR = `${__dirname}/tmp`

sharp.cache(0)

module.exports = (coord, hollaback) => {
  let point = {
    "type": "Point",
    "coordinates": [-89, 43]
  }

  let bigBuffer = envelope(buffer(point, 4, 'miles'))
  let smallBuffer = envelope(buffer(point, 2, 'miles'))

  let minLats = smallBuffer.geometry.coordinates[0].map(coords => {
    return coords[1]
  })

  let minLat = Math.min.apply(null, minLats)
  let maxLat = Math.max.apply(null, minLats)

  // let minLat = Math.min(...minLats)
  // let maxLat = Math.max(...minLats)

  let maxLngs = bigBuffer.geometry.coordinates[0].map(coords => {
    return coords[0]
  })

  let minMaxLng = Math.min.apply(null, maxLngs)
  let maxMaxLng = Math.max.apply(null, maxLngs)

  // let minMaxLng = Math.min(...maxLngs)
  // let maxMaxLng = Math.max(...maxLngs)

  let pBbox = [ minMaxLng, minLat, maxMaxLng, maxLat ]

  let bounds = bboxPolygon(pBbox)

  let tiles = cover.tiles(bounds.geometry, {
    min_zoom: 12,
    max_zoom: 12
  })
  let tilePaths = tiles.map(tile => {
    return `${TEMP_DIR}/${tile[2]}_${tile[0]}_${tile[1]}.tif`
  })

  const fileName = Math.random().toString(36).substring(15)

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

    (callback) => {
      exec(`gdalwarp -wm 4000 ${tilePaths.join(' ')} ${TEMP_DIR}/${fileName}_merged.tif`, (error, stdout, stderror) => {
        if (error) {
          return callback(error)
        }
        callback(null)
      })
    },

    (callback) => {
      exec(`gdalwarp -te_srs EPSG:4326 -te ${pBbox.join(' ')} ${TEMP_DIR}/${fileName}_merged.tif ${TEMP_DIR}/${fileName}_clipped.tif`, (error, stdout, stderr) => {
        if (error) return callback(error)
        callback(null)
      })
    },

    (callback) => {
      exec(`gdaldem hillshade -s 3 -az 315 -z 4  ${TEMP_DIR}/${fileName}_clipped.tif ${TEMP_DIR}/${fileName}_shaded.tif`, (error, stdout, stderr) => {
        if (error) return callback(error)
        callback(null)
      })
    },

    (callback) => {
      let buffer = sharp(`${TEMP_DIR}/${fileName}_shaded.tif`).toBuffer('jpeg', (error, data, info) => {
        if (error) return callback(error)
        callback(null, data)
      })
    },

    (jpeg, callback) => {
      let toDelete = tilePaths.concat([ `${TEMP_DIR}/${fileName}_merged.tif`, `${TEMP_DIR}/${fileName}_clipped.tif`, `${TEMP_DIR}/${fileName}_shaded.tif`])

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
