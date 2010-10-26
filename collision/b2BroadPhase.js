/*
* Copyright (c) 2006-2007 Erin Catto http:
*
* This software is provided 'as-is', without any express or implied
* warranty.  In no event will the authors be held liable for any damages
* arising from the use of this software.
* Permission is granted to anyone to use this software for any purpose,
* including commercial applications, and to alter it and redistribute it
* freely, subject to the following restrictions:
* 1. The origin of this software must not be misrepresented; you must not
* claim that you wrote the original software. If you use this software
* in a product, an acknowledgment in the product documentation would be
* appreciated but is not required.
* 2. Altered source versions must be plainly marked, and must not be
* misrepresented the original software.
* 3. This notice may not be removed or altered from any source distribution.
*/

goog.provide('box2d.BroadPhase');

goog.require('box2d.Bound');
goog.require('box2d.BoundValues');
goog.require('box2d.PairManager');
goog.require('box2d.Proxy');
goog.require('box2d.Settings');
goog.require('box2d.Vec2');

/*
This broad phase uses the Sweep and Prune algorithm in:
Collision Detection in Interactive 3D Environments by Gino van den Bergen
Also, some ideas, such integral values for fast compares comes from
Bullet (http:/www.bulletphysics.com).
*/

// Notes:
// - we use bound arrays instead of linked lists for cache coherence.
// - we use quantized integral values for fast compares.
// - we use short indices rather than pointers to save memory.
// - we use a stabbing count for fast overlap queries (less than order N).
// - we also use a time stamp on each proxy to speed up the registration of
//   overlap query results.
// - where possible, we compare bound indices instead of values to reduce
//   cache misses (TODO_ERIN).
// - no broadphase is perfect and neither is this one: it is not great for huge
//   worlds (use a multi-SAP instead), it is not great for large objects.
/**
 @constructor
 @param {!box2d.AABB} worldAABB
 @param {!box2d.ContactManager} callback
 */
box2d.BroadPhase = function(worldAABB, callback) {
  // initialize instance variables for references
  this.m_pairManager = new box2d.PairManager();

  /**
   @type {!Array.<box2d.Proxy>}
   */
  this.proxyPool = new Array(box2d.Settings.b2_maxPairs);
  this.m_bounds = new Array(2 * box2d.Settings.b2_maxProxies);
  this.m_queryResults = new Array(box2d.Settings.b2_maxProxies);
  this.m_quantizationFactor = new box2d.Vec2();
  //
  //box2d.Settings.b2Assert(worldAABB.IsValid());
  var i = 0;

  this.m_pairManager.Initialize(this, callback);

  this.m_worldAABB = worldAABB;

  this.m_proxyCount = 0;

  // query results
  for (i = 0; i < box2d.Settings.b2_maxProxies; i++) {
    this.m_queryResults[i] = 0;
  }

  // bounds array
  this.m_bounds = new Array(2);
  for (i = 0; i < 2; i++) {
    this.m_bounds[i] = new Array(2 * box2d.Settings.b2_maxProxies);
    for (var j = 0; j < 2 * box2d.Settings.b2_maxProxies; j++) {
      this.m_bounds[i][j] = new box2d.Bound();
    }
  }

  //var d = box2d.Math.SubtractVV(worldAABB.maxVertex, worldAABB.minVertex);
  var dX = worldAABB.maxVertex.x;
  var dY = worldAABB.maxVertex.y;
  dX -= worldAABB.minVertex.x;
  dY -= worldAABB.minVertex.y;

  this.m_quantizationFactor.x = box2d.Settings.USHRT_MAX / dX;
  this.m_quantizationFactor.y = box2d.Settings.USHRT_MAX / dY;

  var tProxy;
  for (i = 0; i < box2d.Settings.b2_maxProxies - 1; ++i) {
    tProxy = new box2d.Proxy();
    this.proxyPool[i] = tProxy;
    tProxy.SetNext(i + 1);
    tProxy.timeStamp = 0;
    tProxy.overlapCount = box2d.Settings.invalid;
    tProxy.userData = null;
  }
  tProxy = new box2d.Proxy();
  this.proxyPool[box2d.Settings.b2_maxProxies - 1] = tProxy;
  tProxy.SetNext(box2d.Pair.b2_nullProxy);
  tProxy.timeStamp = 0;
  tProxy.overlapCount = box2d.Settings.invalid;
  tProxy.userData = null;
  this.m_freeProxy = 0;

  this.m_timeStamp = 1;
  this.m_queryResultCount = 0;
};

//~b2BroadPhase();
// Use this to see if your proxy is in range. If it is not in range,
// it should be destroyed. Otherwise you may get O(m^2) pairs, where m
// is the number of proxies that are out of range.
box2d.BroadPhase.prototype.InRange = function(aabb) {
  //var d = box2d.Math.b2MaxV(box2d.Math.SubtractVV(aabb.minVertex, this.m_worldAABB.maxVertex), box2d.Math.SubtractVV(this.m_worldAABB.minVertex, aabb.maxVertex));
  var dX;
  var dY;
  var d2X;
  var d2Y;

  dX = aabb.minVertex.x;
  dY = aabb.minVertex.y;
  dX -= this.m_worldAABB.maxVertex.x;
  dY -= this.m_worldAABB.maxVertex.y;

  d2X = this.m_worldAABB.minVertex.x;
  d2Y = this.m_worldAABB.minVertex.y;
  d2X -= aabb.maxVertex.x;
  d2Y -= aabb.maxVertex.y;

  dX = Math.max(dX, d2X);
  dY = Math.max(dY, d2Y);

  return Math.max(dX, dY) < 0.0;
};

// Get a single proxy. Returns NULL if the id is invalid.
box2d.BroadPhase.prototype.GetProxy = function(proxyId) {
  if (proxyId == box2d.Pair.b2_nullProxy || this.proxyPool[proxyId].IsValid() == false) {
    return null;
  }

  return this.proxyPool[proxyId];
};

box2d.BroadPhase.prototype.DestroyProxy = function(proxyId) {

  //box2d.Settings.b2Assert(0 < this.m_proxyCount && this.m_proxyCount <= b2_maxProxies);
  var proxy = this.proxyPool[proxyId];
  //box2d.Settings.b2Assert(proxy.IsValid());
  var boundCount = 2 * this.m_proxyCount;

  for (var axis = 0; axis < 2; ++axis) {
    var bounds = this.m_bounds[axis];

    var lowerIndex = proxy.lowerBounds[axis];
    var upperIndex = proxy.upperBounds[axis];
    var lowerValue = bounds[lowerIndex].value;
    var upperValue = bounds[upperIndex].value;

    // replace memmove calls
    //memmove(bounds + lowerIndex, bounds + lowerIndex + 1, (upperIndex - lowerIndex - 1) * sizeof(b2Bound));
    var tArr = new Array();
    var j = 0;
    var tEnd = upperIndex - lowerIndex - 1;
    var tBound1;
    var tBound2;
    // make temp array
    for (j = 0; j < tEnd; j++) {
      tArr[j] = new box2d.Bound();
      tBound1 = tArr[j];
      tBound2 = bounds[lowerIndex + 1 + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }
    // move temp array back in to bounds
    tEnd = tArr.length;
    var tIndex = lowerIndex;
    for (j = 0; j < tEnd; j++) {
      //bounds[tIndex+j] = tArr[j];
      tBound2 = tArr[j];
      tBound1 = bounds[tIndex + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }
    //memmove(bounds + upperIndex-1, bounds + upperIndex + 1, (edgeCount - upperIndex - 1) * sizeof(b2Bound));
    // make temp array
    tArr = new Array();
    tEnd = boundCount - upperIndex - 1;
    for (j = 0; j < tEnd; j++) {
      tArr[j] = new box2d.Bound();
      tBound1 = tArr[j];
      tBound2 = bounds[upperIndex + 1 + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }
    // move temp array back in to bounds
    tEnd = tArr.length;
    tIndex = upperIndex - 1;
    for (j = 0; j < tEnd; j++) {
      //bounds[tIndex+j] = tArr[j];
      tBound2 = tArr[j];
      tBound1 = bounds[tIndex + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }

    // Fix bound indices.
    tEnd = boundCount - 2;
    for (var index = lowerIndex; index < tEnd; ++index) {
      var proxy2 = this.proxyPool[bounds[index].proxyId];
      if (bounds[index].IsLower()) {
        proxy2.lowerBounds[axis] = index;
      } else {
        proxy2.upperBounds[axis] = index;
      }
    }

    // Fix stabbing count.
    tEnd = upperIndex - 1;
    for (var index2 = lowerIndex; index2 < tEnd; ++index2) {
      bounds[index2].stabbingCount--;
    }

    // this.Query for pairs to be removed. lowerIndex and upperIndex are not needed.
    // make lowerIndex and upper output using an array and do this for others if compiler doesn't pick them up
    this.Query([0], [0], lowerValue, upperValue, bounds, boundCount - 2, axis);
  }

  //box2d.Settings.b2Assert(this.m_queryResultCount < box2d.Settings.b2_maxProxies);
  for (var i = 0; i < this.m_queryResultCount; ++i) {
    //box2d.Settings.b2Assert(this.proxyPool[this.m_queryResults[i]].IsValid());
    this.m_pairManager.RemoveBufferedPair(proxyId, this.m_queryResults[i]);
  }

  this.m_pairManager.Commit();

  // Prepare for next query.
  this.m_queryResultCount = 0;
  this.IncrementTimeStamp();

  // Return the proxy to the pool.
  proxy.userData = null;
  proxy.overlapCount = box2d.Settings.invalid;
  proxy.lowerBounds[0] = box2d.Settings.invalid;
  proxy.lowerBounds[1] = box2d.Settings.invalid;
  proxy.upperBounds[0] = box2d.Settings.invalid;
  proxy.upperBounds[1] = box2d.Settings.invalid;

  proxy.SetNext(this.m_freeProxy);
  this.m_freeProxy = proxyId;
  --this.m_proxyCount;
};

// this.Query an AABB for overlapping proxies, returns the user data and
// the count, up to the supplied maximum count.
box2d.BroadPhase.prototype.QueryAABB = function(aabb, userData, maxCount) {
  var lowerValues = new Array();
  var upperValues = new Array();
  this.ComputeBounds(lowerValues, upperValues, aabb);

  var lowerIndex = 0;
  var upperIndex = 0;
  var lowerIndexOut = [lowerIndex];
  var upperIndexOut = [upperIndex];
  this.Query(lowerIndexOut, upperIndexOut, lowerValues[0], upperValues[0], this.m_bounds[0], 2 * this.m_proxyCount, 0);
  this.Query(lowerIndexOut, upperIndexOut, lowerValues[1], upperValues[1], this.m_bounds[1], 2 * this.m_proxyCount, 1);

  //box2d.Settings.b2Assert(this.m_queryResultCount < box2d.Settings.b2_maxProxies);
  var count = 0;
  for (var i = 0; i < this.m_queryResultCount && count < maxCount; ++i, ++count) {
    //box2d.Settings.b2Assert(this.m_queryResults[i] < box2d.Settings.b2_maxProxies);
    var proxy = this.proxyPool[this.m_queryResults[i]];
    //box2d.Settings.b2Assert(proxy.IsValid());
    userData[i] = proxy.userData;
  }

  // Prepare for next query.
  this.m_queryResultCount = 0;
  this.IncrementTimeStamp();

  return count;
};

box2d.BroadPhase.prototype.Validate = function() {
  var pair;
  var proxy1;
  var proxy2;
  var overlap;

  for (var axis = 0; axis < 2; ++axis) {
    var bounds = this.m_bounds[axis];

    var boundCount = 2 * this.m_proxyCount;
    var stabbingCount = 0;

    for (var i = 0; i < boundCount; ++i) {
      var bound = bounds[i];
      //box2d.Settings.b2Assert(i == 0 || bounds[i-1].value <= bound->value);
      //box2d.Settings.b2Assert(bound->proxyId != b2_nullProxy);
      //box2d.Settings.b2Assert(this.proxyPool[bound->proxyId].IsValid());
      if (bound.IsLower() == true) {
        //box2d.Settings.b2Assert(this.proxyPool[bound.proxyId].lowerBounds[axis] == i);
        stabbingCount++;
      } else {
        //box2d.Settings.b2Assert(this.proxyPool[bound.proxyId].upperBounds[axis] == i);
        stabbingCount--;
      }

      //box2d.Settings.b2Assert(bound.stabbingCount == stabbingCount);
    }
  }

};

//private:
box2d.BroadPhase.prototype.ComputeBounds = function(lowerValues, upperValues, aabb) {
  //box2d.Settings.b2Assert(aabb.maxVertex.x > aabb.minVertex.x);
  //box2d.Settings.b2Assert(aabb.maxVertex.y > aabb.minVertex.y);
  //var minVertex = box2d.Math.b2ClampV(aabb.minVertex, this.m_worldAABB.minVertex, this.m_worldAABB.maxVertex);
  var minVertexX = aabb.minVertex.x;
  var minVertexY = aabb.minVertex.y;
  minVertexX = Math.min(minVertexX, this.m_worldAABB.maxVertex.x);
  minVertexY = Math.min(minVertexY, this.m_worldAABB.maxVertex.y);
  minVertexX = Math.max(minVertexX, this.m_worldAABB.minVertex.x);
  minVertexY = Math.max(minVertexY, this.m_worldAABB.minVertex.y);

  //var maxVertex = box2d.Math.b2ClampV(aabb.maxVertex, this.m_worldAABB.minVertex, this.m_worldAABB.maxVertex);
  var maxVertexX = aabb.maxVertex.x;
  var maxVertexY = aabb.maxVertex.y;
  maxVertexX = Math.min(maxVertexX, this.m_worldAABB.maxVertex.x);
  maxVertexY = Math.min(maxVertexY, this.m_worldAABB.maxVertex.y);
  maxVertexX = Math.max(maxVertexX, this.m_worldAABB.minVertex.x);
  maxVertexY = Math.max(maxVertexY, this.m_worldAABB.minVertex.y);

  // Bump lower bounds downs and upper bounds up. This ensures correct sorting of
  // lower/upper bounds that would have equal values.
  // TODO_ERIN implement fast float to uint16 conversion.
  lowerValues[0] =
  /*uint*/
  (this.m_quantizationFactor.x * (minVertexX - this.m_worldAABB.minVertex.x)) & (box2d.Settings.USHRT_MAX - 1);
  upperValues[0] = (
  /*uint*/
  (this.m_quantizationFactor.x * (maxVertexX - this.m_worldAABB.minVertex.x)) & 0x0000ffff) | 1;

  lowerValues[1] =
  /*uint*/
  (this.m_quantizationFactor.y * (minVertexY - this.m_worldAABB.minVertex.y)) & (box2d.Settings.USHRT_MAX - 1);
  upperValues[1] = (
  /*uint*/
  (this.m_quantizationFactor.y * (maxVertexY - this.m_worldAABB.minVertex.y)) & 0x0000ffff) | 1;
};

// This one is only used for validation.
box2d.BroadPhase.prototype.TestOverlapValidate = function(p1, p2) {

  for (var axis = 0; axis < 2; ++axis) {
    var bounds = this.m_bounds[axis];

    //box2d.Settings.b2Assert(p1.lowerBounds[axis] < 2 * this.m_proxyCount);
    //box2d.Settings.b2Assert(p1.upperBounds[axis] < 2 * this.m_proxyCount);
    //box2d.Settings.b2Assert(p2.lowerBounds[axis] < 2 * this.m_proxyCount);
    //box2d.Settings.b2Assert(p2.upperBounds[axis] < 2 * this.m_proxyCount);
    if (bounds[p1.lowerBounds[axis]].value > bounds[p2.upperBounds[axis]].value) return false;

    if (bounds[p1.upperBounds[axis]].value < bounds[p2.lowerBounds[axis]].value) return false;
  }

  return true;
};

box2d.BroadPhase.prototype.TestOverlap = function(b, p) {
  for (var axis = 0; axis < 2; ++axis) {
    var bounds = this.m_bounds[axis];

    //box2d.Settings.b2Assert(p.lowerBounds[axis] < 2 * this.m_proxyCount);
    //box2d.Settings.b2Assert(p.upperBounds[axis] < 2 * this.m_proxyCount);
    if (b.lowerValues[axis] > bounds[p.upperBounds[axis]].value) return false;

    if (b.upperValues[axis] < bounds[p.lowerBounds[axis]].value) return false;
  }

  return true;
};

box2d.BroadPhase.prototype.Query = function(lowerQueryOut, upperQueryOut, lowerValue, upperValue, bounds, boundCount, axis) {

  var lowerQuery = box2d.BroadPhase.BinarySearch(bounds, boundCount, lowerValue);
  var upperQuery = box2d.BroadPhase.BinarySearch(bounds, boundCount, upperValue);

  // Easy case: lowerQuery <= lowerIndex(i) < upperQuery
  // Solution: search query range for min bounds.
  for (var j = lowerQuery; j < upperQuery; ++j) {
    if (bounds[j].IsLower()) {
      this.IncrementOverlapCount(bounds[j].proxyId);
    }
  }

  // Hard case: lowerIndex(i) < lowerQuery < upperIndex(i)
  // Solution: use the stabbing count to search down the bound array.
  if (lowerQuery > 0) {
    var i = lowerQuery - 1;
    var s = bounds[i].stabbingCount;

    // Find the s overlaps.
    while (s) {
      //box2d.Settings.b2Assert(i >= 0);
      if (bounds[i].IsLower()) {
        var proxy = this.proxyPool[bounds[i].proxyId];
        if (lowerQuery <= proxy.upperBounds[axis]) {
          this.IncrementOverlapCount(bounds[i].proxyId);
          --s;
        }
      } --i;
    }
  }

  lowerQueryOut[0] = lowerQuery;
  upperQueryOut[0] = upperQuery;
};

box2d.BroadPhase.prototype.IncrementOverlapCount = function(proxyId) {
  var proxy = this.proxyPool[proxyId];
  if (proxy.timeStamp < this.m_timeStamp) {
    proxy.timeStamp = this.m_timeStamp;
    proxy.overlapCount = 1;
  } else {
    proxy.overlapCount = 2;
    //box2d.Settings.b2Assert(this.m_queryResultCount < box2d.Settings.b2_maxProxies);
    this.m_queryResults[this.m_queryResultCount] = proxyId;
    ++this.m_queryResultCount;
  }
};
box2d.BroadPhase.prototype.IncrementTimeStamp = function() {
  if (this.m_timeStamp == box2d.Settings.USHRT_MAX) {
    for (var i = 0; i < box2d.Settings.b2_maxProxies; ++i) {
      this.proxyPool[i].timeStamp = 0;
    }
    this.m_timeStamp = 1;
  } else {
    ++this.m_timeStamp;
  }
};

// Call this.MoveProxy times like, then when you are done
// call this.Commit to finalized the proxy pairs (for your time step).
/**
 @param {number} proxyId
 @param {!box2d.AABB} aabb
 */
box2d.BroadPhase.prototype.MoveProxy = function(proxyId, aabb) {
  var axis = 0;
  var index = 0;
  var bound;
  var prevBound;
  var nextBound;
  var nextProxyId = 0;
  var nextProxy;

  if (proxyId == box2d.Pair.b2_nullProxy || box2d.Settings.b2_maxProxies <= proxyId) {
    //box2d.Settings.b2Assert(false);
    return;
  }

  if (aabb.IsValid() == false) {
    //box2d.Settings.b2Assert(false);
    return;
  }

  var boundCount = 2 * this.m_proxyCount;

  var proxy = this.proxyPool[proxyId];
  // Get new bound values
  var newValues = new box2d.BoundValues();
  this.ComputeBounds(newValues.lowerValues, newValues.upperValues, aabb);

  // Get old bound values
  var oldValues = new box2d.BoundValues();
  for (axis = 0; axis < 2; ++axis) {
    oldValues.lowerValues[axis] = this.m_bounds[axis][proxy.lowerBounds[axis]].value;
    oldValues.upperValues[axis] = this.m_bounds[axis][proxy.upperBounds[axis]].value;
  }

  for (axis = 0; axis < 2; ++axis) {
    var bounds = this.m_bounds[axis];

    var lowerIndex = proxy.lowerBounds[axis];
    var upperIndex = proxy.upperBounds[axis];

    var lowerValue = newValues.lowerValues[axis];
    var upperValue = newValues.upperValues[axis];

    var deltaLower = lowerValue - bounds[lowerIndex].value;
    var deltaUpper = upperValue - bounds[upperIndex].value;

    bounds[lowerIndex].value = lowerValue;
    bounds[upperIndex].value = upperValue;

    //
    // Expanding adds overlaps
    //
    // Should we move the lower bound down?
    if (deltaLower < 0) {
      index = lowerIndex;
      while (index > 0 && lowerValue < bounds[index - 1].value) {
        bound = bounds[index];
        prevBound = bounds[index - 1];

        var prevProxyId = prevBound.proxyId;
        var prevProxy = this.proxyPool[prevBound.proxyId];

        prevBound.stabbingCount++;

        if (prevBound.IsUpper() == true) {
          if (this.TestOverlap(newValues, prevProxy)) {
            this.m_pairManager.AddBufferedPair(proxyId, prevProxyId);
          }

          prevProxy.upperBounds[axis]++;
          bound.stabbingCount++;
        } else {
          prevProxy.lowerBounds[axis]++;
          bound.stabbingCount--;
        }

        proxy.lowerBounds[axis]--;

        // swap
        //var temp = bound;
        //bound = prevEdge;
        //prevEdge = temp;
        bound.Swap(prevBound);
        //box2d.Math.b2Swap(bound, prevEdge);
        --index;
      }
    }

    // Should we move the upper bound up?
    if (deltaUpper > 0) {
      index = upperIndex;
      while (index < boundCount - 1 && bounds[index + 1].value <= upperValue) {
        bound = bounds[index];
        nextBound = bounds[index + 1];
        nextProxyId = nextBound.proxyId;
        nextProxy = this.proxyPool[nextProxyId];

        nextBound.stabbingCount++;

        if (nextBound.IsLower() == true) {
          if (this.TestOverlap(newValues, nextProxy)) {
            this.m_pairManager.AddBufferedPair(proxyId, nextProxyId);
          }

          nextProxy.lowerBounds[axis]--;
          bound.stabbingCount++;
        } else {
          nextProxy.upperBounds[axis]--;
          bound.stabbingCount--;
        }

        proxy.upperBounds[axis]++;
        // swap
        //var temp = bound;
        //bound = nextEdge;
        //nextEdge = temp;
        bound.Swap(nextBound);
        //box2d.Math.b2Swap(bound, nextEdge);
        index++;
      }
    }

    //
    // Shrinking removes overlaps
    //
    // Should we move the lower bound up?
    if (deltaLower > 0) {
      index = lowerIndex;
      while (index < boundCount - 1 && bounds[index + 1].value <= lowerValue) {
        bound = bounds[index];
        nextBound = bounds[index + 1];

        nextProxyId = nextBound.proxyId;
        nextProxy = this.proxyPool[nextProxyId];

        nextBound.stabbingCount--;

        if (nextBound.IsUpper()) {
          if (this.TestOverlap(oldValues, nextProxy)) {
            this.m_pairManager.RemoveBufferedPair(proxyId, nextProxyId);
          }

          nextProxy.upperBounds[axis]--;
          bound.stabbingCount--;
        } else {
          nextProxy.lowerBounds[axis]--;
          bound.stabbingCount++;
        }

        proxy.lowerBounds[axis]++;
        // swap
        //var temp = bound;
        //bound = nextEdge;
        //nextEdge = temp;
        bound.Swap(nextBound);
        //box2d.Math.b2Swap(bound, nextEdge);
        index++;
      }
    }

    // Should we move the upper bound down?
    if (deltaUpper < 0) {
      index = upperIndex;
      while (index > 0 && upperValue < bounds[index - 1].value) {
        bound = bounds[index];
        prevBound = bounds[index - 1];

        prevProxyId = prevBound.proxyId;
        prevProxy = this.proxyPool[prevProxyId];

        prevBound.stabbingCount--;

        if (prevBound.IsLower() == true) {
          if (this.TestOverlap(oldValues, prevProxy)) {
            this.m_pairManager.RemoveBufferedPair(proxyId, prevProxyId);
          }

          prevProxy.lowerBounds[axis]++;
          bound.stabbingCount--;
        } else {
          prevProxy.upperBounds[axis]++;
          bound.stabbingCount++;
        }

        proxy.upperBounds[axis]--;
        // swap
        //var temp = bound;
        //bound = prevEdge;
        //prevEdge = temp;
        bound.Swap(prevBound);
        //box2d.Math.b2Swap(bound, prevEdge);
        index--;
      }
    }
  }
};

/**
 @return {!Array.<box2d.Pair>}
 */
box2d.BroadPhase.prototype.Commit = function() {
  return this.m_pairManager.Commit();
};

/**
 // Create and destroy proxies. These call Flush first.
 @param {!box2d.AABB} aabb
 @param {!box2d.Shape} userData
 @return {number}
 */
box2d.BroadPhase.prototype.CreateProxy = function(aabb, userData) {
  var index = 0;
  var proxy;

  //box2d.Settings.b2Assert(this.m_proxyCount < b2_maxProxies);
  //box2d.Settings.b2Assert(this.m_freeProxy != box2d.Pair.b2_nullProxy);
  var proxyId = this.m_freeProxy;
  proxy = this.proxyPool[proxyId];
  this.m_freeProxy = proxy.GetNext();

  proxy.overlapCount = 0;
  proxy.userData = userData;

  var boundCount = 2 * this.m_proxyCount;

  var lowerValues = new Array();
  var upperValues = new Array();
  this.ComputeBounds(lowerValues, upperValues, aabb);

  for (var axis = 0; axis < 2; ++axis) {
    var bounds = this.m_bounds[axis];
    var lowerIndex = 0;
    var upperIndex = 0;
    var lowerIndexOut = [lowerIndex];
    var upperIndexOut = [upperIndex];
    this.Query(lowerIndexOut, upperIndexOut, lowerValues[axis], upperValues[axis], bounds, boundCount, axis);
    lowerIndex = lowerIndexOut[0];
    upperIndex = upperIndexOut[0];

    // Replace memmove calls
    //memmove(bounds + upperIndex + 2, bounds + upperIndex, (edgeCount - upperIndex) * sizeof(b2Bound));
    var tArr = new Array();
    var j = 0;
    var tEnd = boundCount - upperIndex;
    var tBound1;
    var tBound2;
    // make temp array
    for (j = 0; j < tEnd; j++) {
      tArr[j] = new box2d.Bound();
      tBound1 = tArr[j];
      tBound2 = bounds[upperIndex + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }
    // move temp array back in to bounds
    tEnd = tArr.length;
    var tIndex = upperIndex + 2;
    for (j = 0; j < tEnd; j++) {
      //bounds[tIndex+j] = tArr[j];
      tBound2 = tArr[j];
      tBound1 = bounds[tIndex + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }
    //memmove(bounds + lowerIndex + 1, bounds + lowerIndex, (upperIndex - lowerIndex) * sizeof(b2Bound));
    // make temp array
    tArr = new Array();
    tEnd = upperIndex - lowerIndex;
    for (j = 0; j < tEnd; j++) {
      tArr[j] = new box2d.Bound();
      tBound1 = tArr[j];
      tBound2 = bounds[lowerIndex + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }
    // move temp array back in to bounds
    tEnd = tArr.length;
    tIndex = lowerIndex + 1;
    for (j = 0; j < tEnd; j++) {
      //bounds[tIndex+j] = tArr[j];
      tBound2 = tArr[j];
      tBound1 = bounds[tIndex + j];
      tBound1.value = tBound2.value;
      tBound1.proxyId = tBound2.proxyId;
      tBound1.stabbingCount = tBound2.stabbingCount;
    }

    // The upper index has increased because of the lower bound insertion.
    ++upperIndex;

    // Copy in the new bounds.
    bounds[lowerIndex].value = lowerValues[axis];
    bounds[lowerIndex].proxyId = proxyId;
    bounds[upperIndex].value = upperValues[axis];
    bounds[upperIndex].proxyId = proxyId;

    bounds[lowerIndex].stabbingCount = lowerIndex == 0 ? 0 : bounds[lowerIndex - 1].stabbingCount;
    bounds[upperIndex].stabbingCount = bounds[upperIndex - 1].stabbingCount;

    // Adjust the stabbing count between the new bounds.
    for (index = lowerIndex; index < upperIndex; ++index) {
      bounds[index].stabbingCount++;
    }

    // Adjust the all the affected bound indices.
    for (index = lowerIndex; index < boundCount + 2; ++index) {
      var proxy2 = this.proxyPool[bounds[index].proxyId];
      if (bounds[index].IsLower()) {
        proxy2.lowerBounds[axis] = index;
      } else {
        proxy2.upperBounds[axis] = index;
      }
    }
  }

  ++this.m_proxyCount;

  //box2d.Settings.b2Assert(this.m_queryResultCount < box2d.Settings.b2_maxProxies);
  for (var i = 0; i < this.m_queryResultCount; ++i) {
    //box2d.Settings.b2Assert(this.m_queryResults[i] < b2_maxProxies);
    //box2d.Settings.b2Assert(this.proxyPool[this.m_queryResults[i]].IsValid());
    this.m_pairManager.AddBufferedPair(proxyId, this.m_queryResults[i]);
  }

  this.m_pairManager.Commit();

  // Prepare for next query.
  this.m_queryResultCount = 0;
  this.IncrementTimeStamp();

  return proxyId;
};

/**
 @private
 @type {number}
 */
box2d.BroadPhase.m_freeProxy = 0;

box2d.BroadPhase.s_validate = false;
box2d.BroadPhase.b2_nullEdge = box2d.Settings.USHRT_MAX;
box2d.BroadPhase.BinarySearch = function(bounds, count, value) {
  var low = 0;
  var high = count - 1;
  while (low <= high) {
    var mid = Math.floor((low + high) / 2);
    if (bounds[mid].value > value) {
      high = mid - 1;
    } else if (bounds[mid].value < value) {
      low = mid + 1;
    } else {
      return (mid);
    }
  }

  return (low);
};
