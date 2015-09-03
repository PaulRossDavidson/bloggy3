
BloggyApp.controller('HomeCtrl', ['$scope','Post', '$modal', function($scope, Post, $modal){

  $scope.posts = [];

  Post.query().then(function(posts){
    $scope.posts = posts
  });

  $scope.deletePost = function(post){
    post.$delete();
  }
  $scope.editPost = function(post){
    console.log('edit', post);
    $modal.open({
      templateUrl:'/views/post/editModal.html',
      controller: 'PostEditModalCtrl',
      resolve:{
        editPost: function(){
          return post;
        }
      }
    });
  }
}]);

